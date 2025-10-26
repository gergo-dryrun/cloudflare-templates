// test/index.spec.ts
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Image Resizing with R2 Worker", () => {
	// Mock image data - a simple 1x1 pixel JPEG
	const mockImageData = new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
		0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
		0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
		0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
		0x13, 0x0f, 0xff, 0xd9,
	]);

	beforeEach(async () => {
		// Setup: Put a test image in the mock R2 bucket
		await env.MY_BUCKET.put("test-image.jpg", mockImageData, {
			httpMetadata: {
				contentType: "image/jpeg",
				cacheControl: "public, max-age=3600",
			},
		});
	});

	it("returns 400 for invalid URL format", async () => {
		const request = new IncomingRequest("http://example.com/invalid/path");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid URL format");
	});

	it("returns 400 for invalid preset", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/invalid-preset/test-image.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid size preset");
	});

	it("returns 400 for unsupported file format", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/medium/test-file.txt"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Unsupported file format");
	});

	it("returns 404 for non-existent image", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/medium/nonexistent.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.text()).toContain("Image not found");
	});

	it("successfully processes image with valid preset", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/medium/test-image.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("medium");
		expect(response.headers.get("X-Image-Width")).toBe("600");
	});

	it("processes thumbnail preset correctly", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/thumbnail/test-image.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("thumbnail");
		expect(response.headers.get("X-Image-Width")).toBe("150");
	});

	it("processes xlarge preset correctly", async () => {
		const request = new IncomingRequest(
			"http://example.com/images/xlarge/test-image.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("xlarge");
		expect(response.headers.get("X-Image-Width")).toBe("1920");
	});

	it("handles nested paths in image filenames", async () => {
		// Setup: Put a test image in a nested path
		await env.MY_BUCKET.put("products/category/item.jpg", mockImageData, {
			httpMetadata: {
				contentType: "image/jpeg",
			},
		});

		const request = new IncomingRequest(
			"http://example.com/images/medium/products/category/item.jpg"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("medium");
	});

	it("handles WebP format", async () => {
		// Setup: Put a WebP image
		await env.MY_BUCKET.put("test-image.webp", mockImageData, {
			httpMetadata: {
				contentType: "image/webp",
			},
		});

		const request = new IncomingRequest(
			"http://example.com/images/small/test-image.webp"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("small");
		expect(response.headers.get("X-Image-Width")).toBe("300");
	});

	it("handles PNG format", async () => {
		// Setup: Put a PNG image
		await env.MY_BUCKET.put("test-image.png", mockImageData, {
			httpMetadata: {
				contentType: "image/png",
			},
		});

		const request = new IncomingRequest(
			"http://example.com/images/large/test-image.png"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Image-Preset")).toBe("large");
		expect(response.headers.get("X-Image-Width")).toBe("900");
	});
});

