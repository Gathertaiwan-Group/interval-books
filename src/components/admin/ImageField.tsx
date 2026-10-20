/**
 * Admin image picker: preview the current image, upload a replacement, or
 * pick one of the 7 images already bundled with the site.
 *
 * Compression happens entirely client-side before anything is sent to the
 * server — not an optimization, a requirement: Vercel serverless functions
 * cap the request body around 4.5MB, and an un-resized photo straight off a
 * phone (src/assets/bookstore-interior.jpg alone ships at 2.6MB) can blow
 * past that on its own.
 *
 * ⚠️ The pipeline itself now lives in src/lib/admin/image-compress.ts — 4c's
 *    拍照辨識 needs the exact same thing for the exact same reason, and two
 *    copies of a size-limit workaround drift the moment one caller changes a
 *    constant. This component keeps its own 2000px/0.82 numbers by importing
 *    the IMAGE_* constants.
 *
 * The server (src/server/storage.ts, via src/lib/admin/fns/upload.ts) does its
 * own independent validation — this component's checks are only a fast local
 * failure path, never the security boundary.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { imageFor, IMAGE_BY_KEY } from "@/lib/images";
import { uploadImage } from "@/lib/admin/fns/upload";
import {
  compressImage,
  extensionFor,
  IMAGE_MAX_EDGE_PX,
  IMAGE_WEBP_QUALITY,
} from "@/lib/admin/image-compress";

const MAX_EDGE_PX = IMAGE_MAX_EDGE_PX;

export type ImageFieldProps = {
  /** Current image_key: a bundled filename key, a "storage:..." key, or null/empty for "unset". */
  value: string | null | undefined;
  /** Fires with the new image_key after a successful upload or bundle pick, or null after "清除". */
  onChange: (key: string | null) => void;
  /** Bundled asset shown when value is empty/unresolvable — pass the same fallback used with imageFor() at the call site this field is editing. */
  fallback: string;
  label?: string;
  /** 額外的尺寸／比例建議，顯示在壓縮說明上方（例如活動封面要提醒海報會完整顯示）。 */
  hint?: string;
  disabled?: boolean;
  className?: string;
};

/** Downscales + re-encodes a picked file in-browser. Never touches the network. */
async function compressForUpload(file: File): Promise<Blob> {
  return compressImage(file, { maxEdge: IMAGE_MAX_EDGE_PX, quality: IMAGE_WEBP_QUALITY });
}

export function ImageField({
  value,
  onChange,
  fallback,
  label,
  hint,
  disabled,
  className,
}: ImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Object URL for the compressed blob, shown while the upload is in flight
  // (before the parent hands back the persisted `value`). Always revoked
  // before being replaced or on unmount.
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  function replaceLocalPreview(next: string | null) {
    setLocalPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return next;
    });
  }

  const previewSrc = localPreview ?? imageFor(value, fallback);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("請選擇圖片檔案");
      return;
    }

    setBusy(true);
    try {
      const compressed = await compressForUpload(file);
      replaceLocalPreview(URL.createObjectURL(compressed));

      const ext = extensionFor(compressed);
      const formData = new FormData();
      formData.append("file", compressed, `upload.${ext}`);

      const result = await uploadImage({ data: formData });
      onChange(result.key);
      toast.success("圖片已上傳");
    } catch (err) {
      const message = err instanceof Error ? err.message : "上傳失敗，請再試一次";
      setError(message);
      toast.error(message);
      replaceLocalPreview(null);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function pickBundled(key: string) {
    setError(null);
    replaceLocalPreview(null);
    onChange(key);
    setPickerOpen(false);
  }

  function clearImage() {
    setError(null);
    replaceLocalPreview(null);
    onChange(null);
  }

  const controlsDisabled = disabled || busy;

  return (
    <div className={cn("space-y-3", className)}>
      {label ? <p className="text-sm font-medium">{label}</p> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {/* object-contain：預覽要讓管理員看到整張圖。用 cover 的話，直式海報在這裡
            就被裁掉上下，管理員看不出前台會長什麼樣。 */}
        <div className="relative aspect-[4/3] w-full max-w-xs shrink-0 overflow-hidden rounded-md border border-border bg-muted">
          <img src={previewSrc} alt="目前圖片預覽" className="h-full w-full object-contain" />
          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70">
              <Loader2 className="size-6 animate-spin text-foreground" />
            </div>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            disabled={controlsDisabled}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              上傳新圖片
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => setPickerOpen((v) => !v)}
            >
              <ImagePlus className="size-4" />
              從圖庫選擇
            </Button>
            {value ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={controlsDisabled}
                onClick={clearImage}
              >
                <X className="size-4" />
                清除
              </Button>
            ) : null}
          </div>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          <p className="text-xs text-muted-foreground">
            會自動壓縮並轉為 WebP 格式（最長邊 {MAX_EDGE_PX}px）。僅接受 JPEG、PNG、WebP。
          </p>
          {value ? (
            <p className="truncate text-xs text-muted-foreground">圖片代碼：{value}</p>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>

      {pickerOpen ? (
        <div className="grid grid-cols-3 gap-2 rounded-md border border-border p-3 sm:grid-cols-4 md:grid-cols-7">
          {Object.entries(IMAGE_BY_KEY).map(([key, src]) => (
            <button
              key={key}
              type="button"
              disabled={controlsDisabled}
              onClick={() => pickBundled(key)}
              title={key}
              className={cn(
                "group relative aspect-square overflow-hidden rounded-md border-2 transition-colors",
                value === key ? "border-primary" : "border-transparent hover:border-border",
              )}
            >
              <img src={src} alt={key} className="h-full w-full object-cover" />
              {value === key ? (
                <span className="absolute inset-0 flex items-center justify-center bg-primary/20">
                  <Check className="size-5 text-primary-foreground drop-shadow" />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
