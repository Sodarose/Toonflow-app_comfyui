// ComfyUI Gateway 媒体供应商：把 Toonflow 的图片/视频请求转成网关 /v1 任务。
// 需要网关与 ComfyUI 已启动；支持 Qwen-Image-2.1、Z-Image Turbo、FLUX.3 Klein，
// 以及 Wan 2.2 TI2V 5B、MiniMax H3 TI2V 与 H3 Reference。

const rules = [
  {
    type: "input",
    field: "baseUrl" as const,
    title: "网关地址",
    value: "http://127.0.0.1:8790",
    props: { placeholder: "http://127.0.0.1:8790" },
  },
  {
    type: "input",
    field: "token" as const,
    title: "访问 Token（留空表示本机）",
    value: "",
    props: { placeholder: "留空" },
  },
  {
    type: "input",
    field: "style" as const,
    title: "默认风格",
    value: "realistic",
    props: { placeholder: "realistic / anime / illustration / 3d" },
  },
  {
    type: "input",
    field: "timeout" as const,
    title: "超时（秒）",
    value: "1800",
    props: { placeholder: "1800" },
  },
] as const;

type GatewayErrorBody = { error?: { message?: string } };
type UploadRole = "reference" | "firstFrame" | "lastFrame" | "video" | "audio";
type MediaKind = "image" | "video";

interface VideoCapability {
  images: number;
  videos: number;
  audios: number;
  firstFrameRole: UploadRole;
  lastFrame: boolean;
}

const VIDEO_CAPABILITIES: Record<string, VideoCapability> = {
  wan22T2v: { images: 1, videos: 0, audios: 0, firstFrameRole: "reference", lastFrame: false },
  h3T2v: { images: 1, videos: 0, audios: 0, firstFrameRole: "reference", lastFrame: false },
  h3Ref: { images: 9, videos: 3, audios: 3, firstFrameRole: "reference", lastFrame: false },
};

const VIDEO_DURATIONS: Record<string, number[]> = {
  wan22T2v: [2, 3, 4, 5],
  h3T2v: [3, 5],
  h3Ref: [3, 5],
};

const VIDEO_RESOLUTIONS: Record<string, string[]> = {
  wan22T2v: ["832x480", "1280x704"],
  h3T2v: ["864x480", "1344x768"],
  h3Ref: ["864x480", "1344x768"],
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
};

function headers(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function settings(context: {
  config: { baseUrl?: unknown; token?: unknown; timeout?: unknown; style?: unknown };
}): { baseUrl: string; token: string; timeoutSeconds: number; style: string } {
  return {
    baseUrl: String(context.config.baseUrl || "http://127.0.0.1:8790").replace(/\/+$/, ""),
    token: String(context.config.token ?? "").trim(),
    timeoutSeconds: Number(context.config.timeout) || 1800,
    style: String(context.config.style || "realistic").trim(),
  };
}

/** 请求级 style 优先于 provider 配置；支持 request.style 或 request.other.style。 */
function requestStyle(
  defaultStyle: string,
  request: { style?: unknown; other?: Record<string, unknown> },
): string {
  const direct = typeof request.style === "string" ? request.style.trim() : "";
  const fromOther = typeof request.other?.style === "string" ? request.other.style.trim() : "";
  return direct || fromOther || defaultStyle;
}

/** 后处理开关：模型 rules 的 upscale / interpolate 字段，兼容旧版 postprocess 对象。 */
function postprocessFrom(request: { other?: Record<string, unknown> }) {
  const other = request.other ?? {};
  const legacy = other.postprocess;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) return legacy;
  const result: { upscale?: { scale: number }; interpolate?: { multiplier: number } } = {};
  if (other.upscale === true) result.upscale = { scale: 2 };
  if (other.interpolate === true) result.interpolate = { multiplier: 2 };
  return Object.keys(result).length ? result : undefined;
}

function extensionFor(mimeType: string, name?: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = EXTENSION_BY_MIME[normalized];
  if (byMime) return byMime;
  const match = name ? /\.([A-Za-z0-9]{1,8})$/.exec(name) : null;
  return match?.[1]?.toLowerCase() ?? "bin";
}

function mimeFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const clean = name.split("?")[0]?.split("#")[0] ?? name;
  const extension = clean.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  for (const [mime, value] of Object.entries(EXTENSION_BY_MIME)) {
    if (value === extension) return mime;
  }
  return undefined;
}

async function readMedia(
  fetcher: ProviderTools["fetch"],
  input: MediaInput,
  signal?: AbortSignal,
): Promise<{ data: Buffer; mimeType: string; name?: string }> {
  if (input.type === "base64") {
    return {
      data: Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64"),
      mimeType: input.mimeType,
      name: input.name,
    };
  }
  if (input.type === "binary") {
    return { data: Buffer.from(input.data), mimeType: input.mimeType, name: input.name };
  }
  const response = await fetcher(input.url, { signal });
  if (!response.ok) throw new Error(`读取素材失败：HTTP ${response.status}`);
  const headerType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const urlName = input.url.split("?")[0]?.split("#")[0]?.split("/").pop();
  const name = input.name ?? urlName;
  const mimeType =
    input.mimeType ||
    headerType ||
    mimeFromName(name) ||
    "application/octet-stream";
  return { data: Buffer.from(await response.arrayBuffer()), mimeType, name };
}

async function errorMessage(response: Response, tool: ProviderTools): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as GatewayErrorBody;
    if (body.error?.message) return body.error.message;
  } catch {
    // 非 JSON 错误体，继续用原始文本
  }
  return tool.errorMessage(text) || text || `HTTP ${response.status}`;
}

async function uploadAsset(
  fetcher: ProviderTools["fetch"],
  tool: ProviderTools,
  baseUrl: string,
  token: string,
  input: MediaInput,
  role: UploadRole,
  signal?: AbortSignal,
): Promise<string> {
  const media = await readMedia(fetcher, input, signal);
  const extension = extensionFor(media.mimeType, media.name);
  const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const filename = `toonflow-${Date.now()}-${Math.floor(Math.random() * 1000)}.${extension}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${media.mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\n${role}\r\n--${boundary}--\r\n`,
  );
  const response = await fetcher(`${baseUrl}/v1/assets`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, media.data, tail]),
    signal,
  });
  if (!response.ok) throw new Error(`上传素材失败：${await errorMessage(response, tool)}`);
  const data = (await response.json()) as { assetId?: string };
  if (!data?.assetId) throw new Error("上传素材失败：网关未返回 assetId");
  return data.assetId;
}

async function wait(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

interface RunJobOptions {
  baseUrl: string;
  token: string;
  timeoutSeconds: number;
  body: Record<string, unknown>;
  mediaType: MediaKind;
}

async function runJob(
  fetcher: ProviderTools["fetch"],
  tool: ProviderTools,
  onProgress: ((progress: { current: number; total: number }) => void) | undefined,
  signal: AbortSignal | undefined,
  options: RunJobOptions,
): Promise<MediaAsset[]> {
  const { baseUrl, token, timeoutSeconds, body, mediaType } = options;
  const create = await fetcher(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!create.ok) throw new Error(`创建任务失败：${await errorMessage(create, tool)}`);
  const created = (await create.json()) as { jobId?: string };
  if (!created?.jobId) throw new Error("创建任务失败：网关未返回 jobId");
  const jobId = created.jobId;

  // ACT: 取消时同步取消网关任务，避免 ComfyUI 继续占用显存。
  const cancel = () => {
    void fetcher(`${baseUrl}/v1/jobs/${jobId}`, {
      method: "DELETE",
      headers: headers(token),
    }).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
    throw signal.reason;
  }

  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await fetcher(`${baseUrl}/v1/jobs/${jobId}`, {
        headers: headers(token),
        signal,
      });
      if (!response.ok) throw new Error(`查询任务失败：${await errorMessage(response, tool)}`);
      const job = (await response.json()) as {
        status?: string;
        progress?: { percent?: number };
        result?: { count?: number; files?: Array<{ mimeType?: string }> };
        error?: { message?: string; code?: string };
      };
      if (onProgress) {
        const percent = Math.max(0, Math.min(100, Number(job.progress?.percent) || 0));
        onProgress({ current: percent, total: 100 });
      }
      if (job.status === "failed" || job.status === "canceled") {
        throw new Error(job.error?.message || `任务 ${job.status}`);
      }
      if (job.status !== "succeeded") {
        await wait(signal, 2000);
        continue;
      }

      const count = Number(job.result?.count) || 0;
      if (count <= 0) throw new Error(`任务成功但没有返回${mediaType === "image" ? "图片" : "视频"}`);
      const result: MediaAsset[] = [];
      for (let index = 0; index < count; index += 1) {
        const media = await fetcher(
          `${baseUrl}/v1/jobs/${jobId}/result?index=${index}`,
          { headers: headers(token), signal },
        );
        if (!media.ok) throw new Error(`下载结果失败：${await errorMessage(media, tool)}`);
        const data = new Uint8Array(await media.arrayBuffer());
        if (!data.byteLength) throw new Error("网关返回了空结果");
        const mimeType =
          job.result?.files?.[index]?.mimeType ||
          media.headers.get("content-type") ||
          `${mediaType}/octet-stream`;
        if (!mimeType.startsWith(`${mediaType}/`) && mimeType !== "application/octet-stream") {
          throw new Error(`网关返回的结果类型不是 ${mediaType}：${mimeType}`);
        }
        result.push({ mediaType, type: "binary", data, mimeType });
      }
      if (onProgress) onProgress({ current: 100, total: 100 });
      return result;
    }
    throw new Error(`网关任务超时（${timeoutSeconds} 秒），请检查 ComfyUI 队列或提高超时`);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function snapDuration(modelId: string, requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  const supported = VIDEO_DURATIONS[modelId] ?? [];
  if (supported.length === 0 || supported.includes(requested)) return requested;
  let best = supported[0]!;
  for (const value of supported) {
    const distance = Math.abs(value - requested);
    const bestDistance = Math.abs(best - requested);
    if (distance < bestDistance || (distance === bestDistance && value < best)) best = value;
  }
  return best;
}

function snapResolution(modelId: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const supported = VIDEO_RESOLUTIONS[modelId] ?? [];
  if (supported.includes(requested)) return requested;
  const progress = /^(\d{3,4})p$/i.exec(requested);
  if (progress) {
    const targetHeight = Number(progress[1]);
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const value of supported) {
      const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value);
      if (!match) continue;
      const distance = Math.abs(Number(match[2]) - targetHeight);
      if (distance < bestDistance) {
        best = value;
        bestDistance = distance;
      }
    }
    if (best) return best;
  }
  throw new Error(
    `模型 ${modelId} 不支持 resolution=${requested}，可选 ${supported.join(" / ") || "(无)"}`,
  );
}

export default {
  id: "gateway",
  label: "ComfyUI 网关（本地）",
  version: "1.1.0",
  readme:
    "通过本机 ComfyUI Gateway 调用 Qwen-Image-2.1、Z-Image Turbo、FLUX.3 Klein、Wan 2.2 TI2V 5B 与 MiniMax H3。图片支持文生图、单图编辑、多图参考；视频支持文生视频、图生视频（首帧）与 H3 多模态参考（最多 9 图 + 3 视频 + 3 音频）。需要网关和 ComfyUI 已启动。",
  rules,
  models: [
    {
      id: "qwenImage21",
      label: "Qwen-Image-2.1",
      type: "image",
      mode: ["text", "singleImage", "multiReference"] satisfies ImageMode[],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
      ],
    },
    {
      id: "zImageTurbo",
      label: "Z-Image Turbo",
      type: "image",
      mode: ["text"] satisfies ImageMode[],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
      ],
    },
    {
      id: "flux3Klein",
      label: "FLUX.3 Klein",
      type: "image",
      mode: ["text", "singleImage"] satisfies ImageMode[],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
      ],
    },
    {
      id: "wan22T2v",
      label: "Wan 2.2 TI2V (5B)",
      type: "video",
      mode: ["text", "singleImage"] satisfies VideoMode[],
      durationResolutionMap: [
        { duration: [2, 3, 4, 5], resolution: ["832x480", "1280x704"] },
      ],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
        { type: "switch", field: "interpolate", title: "插帧（2x）", value: false },
      ],
    },
    {
      id: "h3T2v",
      label: "MiniMax H3 TI2V",
      type: "video",
      mode: ["text", "singleImage"] satisfies VideoMode[],
      audio: true,
      durationResolutionMap: [{ duration: [3, 5], resolution: ["864x480", "1344x768"] }],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
        { type: "switch", field: "interpolate", title: "插帧（2x）", value: false },
      ],
    },
    {
      id: "h3Ref",
      label: "MiniMax H3 Reference",
      type: "video",
      mode: [
        ["imageReference:9", "videoReference:3", "audioReference:3"] as unknown as VideoMode,
      ],
      audio: true,
      durationResolutionMap: [{ duration: [3, 5], resolution: ["864x480", "1344x768"] }],
      rules: [
        {
          type: "select",
          field: "style",
          title: "风格",
          value: "realistic",
          options: [
            { label: "写实", value: "realistic" },
            { label: "动漫", value: "anime" },
            { label: "插画", value: "illustration" },
            { label: "3D", value: "3d" },
          ],
        },
        { type: "switch", field: "upscale", title: "高清放大（2x）", value: false },
        { type: "switch", field: "interpolate", title: "插帧（2x）", value: false },
      ],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const { baseUrl, token, timeoutSeconds, style: defaultStyle } = settings(this);
    const style = requestStyle(defaultStyle, request);
    const signal = this.signal;
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) throw new Error("请输入图片提示词");
    if (signal?.aborted) throw signal.reason;
    if (request.mask) throw new Error("当前网关暂不支持 mask 局部重绘");

    const assets: Array<{ assetId: string; role: UploadRole }> = [];
    for (const image of request.images ?? []) {
      const assetId = await uploadAsset(
        this.tool.fetch,
        this.tool,
        baseUrl,
        token,
        image,
        "reference",
        signal,
      );
      assets.push({ assetId, role: "reference" });
    }

    const body: Record<string, unknown> = {
      model: String(request.model || "qwenImage21"),
      kind: "image",
      prompt,
      style,
      n: Math.max(1, Math.min(4, Number(request.n) || 1)),
    };
    if (request.size) body.size = request.size;
    if (request.ratio) body.ratio = request.ratio;
    if (request.outputFormat) body.outputFormat = request.outputFormat;
    if (assets.length > 0) body.assets = assets;
    const postprocess = postprocessFrom(request);
    if (postprocess) body.postprocess = postprocess;

    // NOTE: Toonflow 2.0.10 的 ProviderContext 不再暴露 onProgress，进度由宿主任务状态展示。
    return runJob(this.tool.fetch, this.tool, undefined, signal, {
      baseUrl,
      token,
      timeoutSeconds,
      body,
      mediaType: "image",
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const { baseUrl, token, timeoutSeconds, style: defaultStyle } = settings(this);
    const style = requestStyle(defaultStyle, request);
    const signal = this.signal;
    const modelId = String(request.model || "wan22T2v");
    const limits = VIDEO_CAPABILITIES[modelId];
    if (!limits) throw new Error(`不支持的视频模型：${modelId}`);
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) throw new Error("请输入视频提示词");
    if (signal?.aborted) throw signal.reason;

    const imageCount =
      (request.images?.length ?? 0) + (request.firstFrame ? 1 : 0) + (request.lastFrame ? 1 : 0);
    const videoCount = request.videos?.length ?? 0;
    const audioCount = request.audios?.length ?? 0;
    if (imageCount > limits.images) {
      throw new Error(`模型 ${modelId} 最多接受 ${limits.images} 张图片，收到 ${imageCount} 张`);
    }
    if (videoCount > limits.videos) {
      throw new Error(`模型 ${modelId} 最多接受 ${limits.videos} 段参考视频，收到 ${videoCount} 段`);
    }
    if (audioCount > limits.audios) {
      throw new Error(`模型 ${modelId} 最多接受 ${limits.audios} 段参考音频，收到 ${audioCount} 段`);
    }
    if (request.lastFrame && !limits.lastFrame) {
      throw new Error(`模型 ${modelId} 不支持尾帧，请改用首帧或参考图`);
    }
    if (modelId === "h3Ref" && imageCount + videoCount + audioCount === 0) {
      throw new Error("h3Ref 至少需要一张参考图、一段参考视频或一段参考音频");
    }

    const assets: Array<{ assetId: string; role: UploadRole }> = [];
    for (const image of request.images ?? []) {
      assets.push({
        assetId: await uploadAsset(this.tool.fetch, this.tool, baseUrl, token, image, "reference", signal),
        role: "reference",
      });
    }
    if (request.firstFrame) {
      assets.push({
        assetId: await uploadAsset(
          this.tool.fetch,
          this.tool,
          baseUrl,
          token,
          request.firstFrame,
          limits.firstFrameRole,
          signal,
        ),
        role: limits.firstFrameRole,
      });
    }
    if (request.lastFrame) {
      assets.push({
        assetId: await uploadAsset(
          this.tool.fetch,
          this.tool,
          baseUrl,
          token,
          request.lastFrame,
          "lastFrame",
          signal,
        ),
        role: "lastFrame",
      });
    }
    for (const video of request.videos ?? []) {
      assets.push({
        assetId: await uploadAsset(this.tool.fetch, this.tool, baseUrl, token, video, "video", signal),
        role: "video",
      });
    }
    for (const audio of request.audios ?? []) {
      assets.push({
        assetId: await uploadAsset(this.tool.fetch, this.tool, baseUrl, token, audio, "audio", signal),
        role: "audio",
      });
    }

    const body: Record<string, unknown> = {
      model: modelId,
      kind: "video",
      prompt,
      style,
    };
    // h3Ref 只有 reference 工作流；单图时网关会推导成 singleImage，需要显式指定。
    if (modelId === "h3Ref") body.mode = "reference";
    const duration = snapDuration(modelId, request.duration);
    if (duration !== undefined) body.duration = duration;
    const resolution = snapResolution(modelId, request.resolution);
    if (resolution) body.resolution = resolution;
    if (request.ratio) body.ratio = request.ratio;
    if (typeof request.generateAudio === "boolean") body.generateAudio = request.generateAudio;
    // mode 由网关按实际素材推导：单图 → singleImage，多模态参考 → reference。
    if (assets.length > 0) body.assets = assets;
    const postprocess = postprocessFrom(request);
    if (postprocess) body.postprocess = postprocess;

    // NOTE: Toonflow 2.0.10 的 ProviderContext 不再暴露 onProgress，进度由宿主任务状态展示。
    return runJob(this.tool.fetch, this.tool, undefined, signal, {
      baseUrl,
      token,
      timeoutSeconds,
      body,
      mediaType: "video",
    });
  },
} satisfies ProviderDefinition<typeof rules>;
