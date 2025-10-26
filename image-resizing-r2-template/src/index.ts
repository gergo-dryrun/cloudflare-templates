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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			// BEST PRACTICE: Prevent request loops
			// If this request is coming from image resizing, fetch directly without processing
			const viaHeader = request.headers.get('via');
			if (viaHeader && /image-resizing/.test(viaHeader)) {
				return fetch(request);
			}

			const url = new URL(request.url);

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
			const r2Object = await env.MY_BUCKET.get(filename);

			if (!r2Object) {
				return new Response(`Image not found: ${filename}`, {
					status: 404,
					headers: { 'Content-Type': 'text/plain' },
				});
			}

			// Prepare resizing options
			const resizingOptions: RequestInitCfPropertiesImage = {
				width: SIZE_PRESETS[preset],
				fit: 'scale-down', // BEST PRACTICE: Never upscale images
				quality: 85, // Good balance between quality and file size
			};

			// BEST PRACTICE: Format negotiation based on Accept header
			const acceptHeader = request.headers.get('Accept') || '';
			if (acceptHeader.includes('image/avif')) {
				resizingOptions.format = 'avif';
			} else if (acceptHeader.includes('image/webp')) {
				resizingOptions.format = 'webp';
			} else {
				// Default to automatic format selection
				resizingOptions.format = 'auto';
			}

			// Create a response from R2 object
			const imageResponse = new Response(r2Object.body, {
				headers: {
					'Content-Type': r2Object.httpMetadata?.contentType || 'application/octet-stream',
					'Cache-Control': r2Object.httpMetadata?.cacheControl || 'public, max-age=3600',
					'ETag': r2Object.httpEtag,
				},
			});

			// BEST PRACTICE: Use request URL for resizing (not R2 internal URL)
			const resizeRequest = new Request(request.url, {
				body: imageResponse.body,
				headers: imageResponse.headers,
			});

			// Apply image resizing
			const resizedResponse = await fetch(resizeRequest, {
				cf: {
					image: resizingOptions,
				},
			});

			// BEST PRACTICE: Error handling with fallback
			if (!resizedResponse.ok && !resizedResponse.redirected) {
				// If resizing fails, return the original image
				console.error(`Image resizing failed: ${resizedResponse.status}`);
				return imageResponse;
			}

			// Add custom headers to indicate processing
			const headers = new Headers(resizedResponse.headers);
			headers.set('X-Image-Preset', preset);
			headers.set('X-Image-Width', SIZE_PRESETS[preset].toString());

			return new Response(resizedResponse.body, {
				status: resizedResponse.status,
				statusText: resizedResponse.statusText,
				headers,
			});
		} catch (error) {
			console.error('Worker error:', error);
			return new Response('Internal server error', {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},
} satisfies ExportedHandler<Env>;

