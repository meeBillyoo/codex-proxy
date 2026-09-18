import { afterEach, describe, expect, it } from "vitest";
import {
  buildImageGenerationCodexRequest,
  ImageGenerationRequestSchema,
} from "@src/routes/shared/image-generation.js";

afterEach(() => {
  delete process.env.CODEX_PROXY_DISABLE_WS;
});

describe("Images API request contract", () => {
  it("maps supported client controls to an image_generation tool on the configured host model", () => {
    const request = ImageGenerationRequestSchema.parse({
      model: "gpt-image-2",
      prompt: "Draw a lunar base",
      size: "1536x1024",
      quality: "hd",
      output_format: "webp",
      output_compression: 75,
      background: "opaque",
      moderation: "low",
      partial_images: 3,
      n: 1,
      response_format: "b64_json",
      stream: false,
    });

    expect(buildImageGenerationCodexRequest(request, "gpt-5.5")).toEqual({
      model: "gpt-5.5",
      instructions: "",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Draw a lunar base" }],
        },
      ],
      stream: true,
      store: false,
      tools: [
        {
          type: "image_generation",
          size: "1536x1024",
          output_format: "webp",
          output_compression: 75,
          background: "opaque",
          moderation: "low",
          partial_images: 3,
        },
      ],
      useWebSocket: true,
    });
  });

  it("uses stable defaults and respects the process-wide WebSocket kill switch", () => {
    process.env.CODEX_PROXY_DISABLE_WS = "1";
    const request = ImageGenerationRequestSchema.parse({
      model: "gpt-image-2",
      prompt: "A simple icon",
    });

    const upstream = buildImageGenerationCodexRequest(request, "gpt-5.4");
    expect(upstream.useWebSocket).toBe(false);
    expect(upstream.tools).toEqual([
      {
        type: "image_generation",
        size: "auto",
        output_format: "png",
      },
    ]);
  });

  it.each([
    [{ model: "gpt-image-2", prompt: "", n: 1 }, "empty prompt"],
    [{ model: "gpt-image-2", prompt: "ok", n: 2 }, "multiple images"],
    [
      { model: "gpt-image-2", prompt: "ok", size: "512x512" },
      "unsupported size",
    ],
    [
      { model: "gpt-image-2", prompt: "ok", partial_images: 4 },
      "too many partial images",
    ],
    [
      { model: "gpt-image-2", prompt: "ok", output_compression: 101 },
      "invalid compression",
    ],
    [{ model: "gpt-image-2", prompt: "ok", stream: true }, "streaming"],
    [
      { model: "gpt-image-2", prompt: "ok", response_format: "url" },
      "URL response",
    ],
  ])("rejects %s before an upstream request (%s)", (value) => {
    expect(ImageGenerationRequestSchema.safeParse(value).success).toBe(false);
  });
});
