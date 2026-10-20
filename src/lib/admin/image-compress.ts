/**
 * 瀏覽器端的圖片壓縮，ImageField 與拍照辨識共用。
 *
 * 這一段本來只長在 src/components/admin/ImageField.tsx 裡。4c 接 OCR 時抽出來，
 * 因為兩邊要的是**同一件事**而不是像的事：兩條路最後都會把 bytes 送進一個
 * Vercel serverless function，而那裡的 request body 大約 4.5MB 就滿了。
 * 一張手機直出的照片自己就能撐爆（來源進銷存的 OCR 就是直接送 5.4MB 的 data URL）。
 *
 * pipeline：
 *   createImageBitmap(file, { imageOrientation: "from-image" })  // 依 EXIF 轉正
 *     -> canvas，長邊上限 maxEdge
 *     -> canvas.toBlob("image/webp", quality)
 *
 * 重畫到 canvas 會順手把所有 metadata（EXIF、GPS…）洗掉 —— 不需要再做別的。
 *
 * ⚠️ 這裡的檢查**不是安全邊界**。伺服器端（src/server/storage.ts）會自己嗅
 *    magic bytes、自己擋大小，不看任何前端送來的宣告。
 */

/**
 * 型錄／商品照，也是 GalleryField（活動相簿）與事件封面／講者照共用的同一組
 * 常數——這個檔案是全站唯一一處壓縮設定，改這裡就是改全部。
 *
 * 2026-09 從 2000px/.82 收緊到 1600px/.80——起因是前台載入速度優化，量到一場
 * 活動頁的四張圖（封面 412KB、相簿 269KB+161KB、講者 90KB，共 932KB）幾乎全是
 * 原圖直出。查了才發現 412KB 那張封面本身就是 2000×1500，剛好卡在舊上限——
 * 不是漏掉壓縮，是舊設定本身就寬鬆到讓一張細節豐富的照片能長到這麼大。
 *
 * 新數字不是憑感覺定的：抓了正式站這四張圖（連同一張已經是 webp 的封面）跑過
 * 這支 compressImage() 本身的演算法，在瀏覽器裡量出真實輸出大小，並且把
 * 1600/.80 與更激進的 1280/.75 兩組跑出來的圖擺在一起放大比對細節（陶器邊緣
 * 的顆粒感）——1280/.75 肉眼幾乎看不出差異，但那組是為「格狀縮圖」量身的尺寸；
 * 這裡的封面圖是 `w-full` 原比例大圖（當時是 21:9 通欄橫幅），容器 `container-editorial`
 * 上限 1280px 再扣掉左右留白，最寬也才約 1184 CSS px，1600px 實體像素在
 * retina 螢幕上還留一點餘裕，1280px 就只剩「非 retina」等級的清晰度——所以
 * 留在畫面更大、更該顧清晰度的 1600px，quality 只從 .82 收到 .80（差距本來就
 * 不大，不必為了多省一點再犧牲清晰度）。
 *
 * 實測結果（今天重壓這四張圖，KB 為 canvas.toBlob 直接量出的位元組數）：
 *   封面（2000×1500 webp，422KB 原檔）  2000/.82 現行 390KB → 1600/.80 新值 210KB
 *   相簿一（1500×2000 jpg，276KB 原檔） 2000/.82 現行  70KB → 1600/.80 新值  39KB
 *   相簿二（1170×880 jpg，165KB 原檔）  2000/.82 現行  68KB → 1600/.80 新值  61KB（長邊本來就 <1600，只有 quality 在起作用）
 *   講者照（800×800 jpg，92KB 原檔）    2000/.82 現行  30KB → 1600/.80 新值  26KB（同上）
 *
 * ⚠️ 這裡只改上傳管線的設定。**Storage 裡現有的圖片不會被這次修改重壓**——
 *    那需要碰 Storage，是另外的工作。新設定只對「這次之後的新上傳」生效。
 */
export const IMAGE_MAX_EDGE_PX = 1600;
export const IMAGE_WEBP_QUALITY = 0.8;

/**
 * 辨識用的掃描圖。
 *
 * 比商品照小一點：辨識吃的是文字清晰度不是解析度，1600px 對書封與 A4 進貨單都
 * 夠讀，而每一次辨識都要把 bytes 轉 base64 送進 Gemini —— 小一點就是快一點、
 * 便宜一點。品質拉高到 0.9，因為壓縮瑕疵會直接變成讀錯的字。
 */
export const OCR_MAX_EDGE_PX = 1600;
export const OCR_WEBP_QUALITY = 0.9;

export type CompressOptions = {
  maxEdge: number;
  quality: number;
};

/**
 * 縮圖並重新編碼。全程在瀏覽器，不碰網路。
 *
 * @throws 瀏覽器不支援 canvas、或編不出任何一種格式時
 */
export async function compressImage(file: File, options: CompressOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    // Math.min(1, …)：只縮不放。本來就比上限小的圖不要被放大成一團糊。
    const scale = Math.min(1, options.maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("此瀏覽器不支援圖片處理");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", options.quality),
    );
    if (webp) return webp;

    // 罕見：編得出 canvas 但編不出 webp 的瀏覽器。jpeg 是通用退路，伺服器也收。
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", options.quality),
    );
    if (jpeg) return jpeg;

    throw new Error("圖片壓縮失敗，請換一張圖片再試");
  } finally {
    bitmap.close();
  }
}

/** 壓縮後的 blob 要用什麼副檔名。伺服器不看它（只嗅 magic bytes），但檔名要合理。 */
export function extensionFor(blob: Blob): "jpg" | "webp" {
  return blob.type === "image/jpeg" ? "jpg" : "webp";
}
