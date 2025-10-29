/**
 * Image Resizing Worker with R2 Storage
 * 
 * This Worker serves images from R2 with on-the-fly resizing using preset size names.
 * It implements Cloudflare best practices for image resizing, caching, and error handling.
 */

/// <reference types="@cloudflare/workers-types" />

export interface Env {
	// R2 bucket binding for storing original images
	MY_BUCKET: R2Bucket;
}

// Preset size definitions (width in pixels)
const SIZE_PRESETS: Record<string, number> = {
	thumbnail: 150,
	small: 300,
	medium: 600,
	large: 900,
	xlarge: 1920,
};

// Supported image file extensions
const SUPPORTED_FORMATS = /\.(jpe?g|png|gif|webp)$/i;

// Helper function to get content type from file extension
function getContentTypeFromFilename(filename: string): string {
	const ext = filename.toLowerCase().split('.').pop();
	switch (ext) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		default:
			return 'application/octet-stream';
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			// BEST PRACTICE: Prevent request loops
			// 1. Production: Check the Via header (added by Cloudflare's image resizing service)
			// 2. Local dev: Check our custom header (to mimic production behavior)
			// See: https://developers.cloudflare.com/images/transform-images/transform-via-workers/#prevent-request-loops
			const viaHeader = request.headers.get('via');
			const loopDetector = request.headers.get('x-resize-loop-detector');
			
			if ((viaHeader && /image-resizing/.test(viaHeader)) || loopDetector === 'internal') {
				console.log('Request from image-resizing service detected, bypassing Worker');
				return fetch(request);
			}

			// Only process GET requests from external clients
			if (request.method !== 'GET') {
				console.error(`Invalid method: ${request.method}`);
				return new Response('Only GET requests are supported', {
					status: 405,
					headers: { 'Content-Type': 'text/plain' },
				});
			}

			const url = new URL(request.url);
			console.log(`Processing request: ${request.method} ${url.pathname}`);

			// Parse URL pattern: /images/[preset]/[filename]
			const pathMatch = url.pathname.match(/^\/images\/([^/]+)\/(.+)$/);

			if (!pathMatch) {
				return new Response('Invalid URL format. Use: /images/[preset]/[filename]', {
					status: 400,
					headers: { 'Content-Type': 'text/plain' },
				});
			}

			const [, preset, filename] = pathMatch;

			// Validate preset
			if (!SIZE_PRESETS[preset]) {
				const validPresets = Object.keys(SIZE_PRESETS).join(', ');
				return new Response(
					`Invalid size preset "${preset}". Valid presets: ${validPresets}`,
					{
						status: 400,
						headers: { 'Content-Type': 'text/plain' },
					}
				);
			}

			// Validate file extension
			if (!SUPPORTED_FORMATS.test(filename)) {
				return new Response(
					'Unsupported file format. Supported formats: jpg, jpeg, png, gif, webp',
					{
						status: 400,
						headers: { 'Content-Type': 'text/plain' },
					}
				);
			}

		// Fetch object from R2
		console.log(`Fetching from R2: ${filename}`);
		const r2Object = await env.MY_BUCKET.get(filename);

			if (!r2Object) {
				console.error(`Image not found in R2: ${filename}`);
				return new Response(`Image not found: ${filename}`, {
					status: 404,
					headers: { 'Content-Type': 'text/plain' },
				});
			}

		console.log(`Successfully fetched from R2: ${filename}`);
		console.log(`Content-Type: ${r2Object.httpMetadata?.contentType || 'not set in R2, will detect from filename'}`);

		// Prepare resizing options
			const resizingOptions: RequestInitCfPropertiesImage = {
				width: SIZE_PRESETS[preset],
				fit: 'scale-down', // BEST PRACTICE: Never upscale images
				quality: 85, // Good balance between quality and file size
			};

		// BEST PRACTICE: Format negotiation based on Accept header
		// If format is omitted, Cloudflare automatically selects the best format
		const acceptHeader = request.headers.get('Accept') || '';
		if (acceptHeader.includes('image/avif')) {
			resizingOptions.format = 'avif';
		} else if (acceptHeader.includes('image/webp')) {
			resizingOptions.format = 'webp';
		}
		// Else: format stays undefined = automatic format selection

		// Create a response from R2 object
		// Use detected content type from filename if R2 doesn't have it set
		const contentType = r2Object.httpMetadata?.contentType || getContentTypeFromFilename(filename);
		console.log(`Serving with Content-Type: ${contentType}`);
		
		const imageResponse = new Response(r2Object.body, {
			headers: {
				'Content-Type': contentType,
				'Cache-Control': r2Object.httpMetadata?.cacheControl || 'public, max-age=3600',
				'ETag': r2Object.httpEtag,
			},
		});

		// IMPORTANT: Image resizing doesn't work in local development
		// In production, we need to use a proper approach for image resizing
		// For now, we'll skip resizing in local dev and return the original image
		
		// Detect if we're in local development (wrangler dev)
		const isLocalDev = url.hostname === 'localhost' || url.hostname.includes('127.0.0.1');
		
		if (isLocalDev) {
			console.warn('⚠️  Image resizing is not available in local development');
			console.warn('   Returning original image without resizing');
			console.warn('   Deploy to Cloudflare to test image resizing functionality');
			
			const headers = new Headers(imageResponse.headers);
			headers.set('X-Image-Preset', preset);
			headers.set('X-Image-Width', SIZE_PRESETS[preset].toString());
			headers.set('X-Resize-Status', 'skipped-local-dev');
			
			return new Response(imageResponse.body, {
				status: 200,
				headers,
			});
		}

		// In production: Try to use Cloudflare Image Resizing
		console.log('Attempting image resizing...');
		
		try {
			// Apply image resizing by fetching with the cf.image options
			// Production: Cloudflare automatically adds 'via: image-resizing' header
			// Local dev: We add custom header to mimic production and prevent loops
			const resizeHeaders = new Headers(request.headers);
			resizeHeaders.set('x-resize-loop-detector', 'internal');
			
			const resizedResponse = await fetch(request.url, {
				headers: resizeHeaders,
				cf: {
					image: resizingOptions,
				},
			});

			// BEST PRACTICE: Error handling with fallback
			if (!resizedResponse.ok && !resizedResponse.redirected) {
				console.error(`Image resizing failed: ${resizedResponse.status}`);
				console.error('Falling back to original image');
				
				const headers = new Headers(imageResponse.headers);
				headers.set('X-Image-Preset', preset);
				headers.set('X-Resize-Status', 'failed-fallback-to-original');
				
				return new Response(imageResponse.body, {
					status: 200,
					headers,
				});
			}

			// Add custom headers to indicate processing
			const headers = new Headers(resizedResponse.headers);
			headers.set('X-Image-Preset', preset);
			headers.set('X-Image-Width', SIZE_PRESETS[preset].toString());
			headers.set('X-Resize-Status', 'success');

			console.log('✓ Image resizing successful');
			
			return new Response(resizedResponse.body, {
				status: resizedResponse.status,
				statusText: resizedResponse.statusText,
				headers,
			});
		} catch (resizeError) {
			console.error('Image resizing error:', resizeError);
			console.error('Falling back to original image');
			
			const headers = new Headers(imageResponse.headers);
			headers.set('X-Image-Preset', preset);
			headers.set('X-Resize-Status', 'error-fallback-to-original');
			
			return new Response(imageResponse.body, {
				status: 200,
				headers,
			});
		}
		} catch (error) {
			console.error('Worker error:', error);
			return new Response('Internal server error', {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},
} satisfies ExportedHandler<Env>;

