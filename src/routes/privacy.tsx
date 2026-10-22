import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText } from "@/lib/cms";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "隱私權 Privacy｜小時光書店 Interval Books",
    en: "Privacy｜Interval Books",
    ja: "プライバシー｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店之隱私權聲明。",
    en: "Privacy statement of Interval Books.",
    ja: "小時光書店のプライバシーに関する声明。",
  },
  title: { zh: "隱私權聲明", en: "Privacy Statement", ja: "プライバシー" },
  body: {
    zh: "小時光書店尊重每一位讀者與顧客的個人資訊。本頁說明我們實際會收集什麼、用在哪裡、又交給了誰。\n## 我們會收集的資料\n訂購與報名：姓名、Email、電話、收件地址（宅配或超商門市），以及您為參加者填寫的姓名與聯絡方式。\n會員帳號：Email 與密碼。密碼以雜湊形式保存，我們無法讀取您的原始密碼。\n發票資訊：您選擇的載具、統一編號或抬頭。\n## 我們不會保存的資料\n信用卡號與卡片背面的安全碼。刷卡是在金流服務商的頁面上完成，卡號不會經過本站，我們也沒有保存。\n## 我們會把資料交給誰\n為了完成您的訂單，以下服務會取得必要範圍內的資料：統一客樂得「黑貓 PAY」與統一金流 PAYUNi（處理付款）、Amego（依法開立電子發票）、Resend（寄送訂單與活動通知信）、Supabase 與 Vercel（資料儲存與網站代管）、物流或超商業者（配送您選擇的取貨方式）。除了完成訂單所必需的範圍，我們不會將您的資料販售或提供給任何第三方。\n## 保存期間\n訂單與發票屬會計憑證，依稅法規定之期限保存。通知信的內文會在寄出滿三十天後自動清除，之後只留下寄送紀錄。\n## Cookie\n本站使用維持登入狀態與購物車所必需的 cookie。本站沒有安裝任何第三方廣告或行為追蹤工具。\n## 您的權利\n您可以隨時登入帳號，查看自己的訂單與活動報名紀錄。若要查詢、更正或刪除您的個人資料，請來信 intervalbookstores@gmail.com，我們會在確認身分後為您處理。\n## 其他\n第三方嵌入服務（如 Google Maps、Instagram）可能依其自身政策蒐集使用紀錄，請參閱該服務之隱私聲明。本聲明可能依實際營運狀況更新，更新版本將直接公佈於本頁。",
    en: "Interval Books respects the privacy of every reader and customer. This page sets out what we actually collect, what we use it for, and who we pass it to.\n## What we collect\nOrders and event registrations: name, email, phone, delivery address (home delivery or convenience-store pickup), and the names and contact details you enter for each participant.\nMember accounts: email and password. Passwords are stored as hashes; we cannot read your original password.\nInvoice details: the carrier, tax ID, or title you choose.\n## What we do not keep\nCard numbers and security codes. Payment is completed on the payment provider's own page — card numbers never pass through this site and we do not store them.\n## Who receives your data\nTo complete your order, the following services receive only what they need: President Collect \"Black Cat PAY\" and PAYUNi (payment processing), Amego (statutory e-invoicing), Resend (order and event notification emails), Supabase and Vercel (data storage and hosting), and the courier or convenience-store operator handling your chosen delivery method. Beyond what is required to complete your order, we do not sell or pass your data to any third party.\n## How long we keep it\nOrders and invoices are accounting records and are kept for the period required by tax law. The body text of notification emails is automatically purged thirty days after sending; only the delivery record remains.\n## Cookies\nThis site uses only the cookies required to keep you signed in and to hold your cart. No third-party advertising or behavioural tracking tools are installed.\n## Your rights\nYou can sign in at any time to view your own orders and event registrations. To access, correct, or delete your personal data, write to intervalbookstores@gmail.com and we will act on it once we have verified your identity.\n## Other\nThird-party embeds (such as Google Maps and Instagram) may collect usage data under their own policies; please see those services' notices. This statement may be updated as operations evolve, and any new version will be posted on this page.",
    ja: "小時光書店は、読者とお客さまおひとりおひとりの個人情報を尊重します。本ページでは、実際に取得する情報、その利用目的、および提供先について説明します。\n## 取得する情報\nご注文・イベント申込：お名前、メールアドレス、電話番号、お届け先住所（宅配またはコンビニ受取）、および参加者ごとにご入力いただくお名前と連絡先。\n会員アカウント：メールアドレスとパスワード。パスワードはハッシュ化して保管しており、元のパスワードを当店が読み取ることはできません。\nインボイス情報：お選びいただいたキャリア、統一番号、または宛名。\n## 保管しない情報\nクレジットカード番号およびセキュリティコード。決済は決済事業者のページ上で完了し、カード番号が当サイトを経由することはなく、保管もしていません。\n## 提供先\nご注文の履行のため、以下のサービスが必要な範囲の情報を取得します：統一客樂得「黑貓 PAY」および統一金流 PAYUNi（決済処理）、Amego（法令に基づく電子インボイス発行）、Resend（注文・イベント通知メールの送信）、Supabase および Vercel（データ保管とホスティング）、配送業者またはコンビニ事業者（お選びの受取方法での配送）。ご注文の履行に必要な範囲を超えて、お客さまの情報を販売または第三者に提供することはありません。\n## 保管期間\nご注文とインボイスは会計帳簿として、税法が定める期間保管します。通知メールの本文は送信から三十日後に自動的に削除され、以後は送信記録のみが残ります。\n## Cookie\n本サイトでは、ログイン状態の維持とカートの保持に必要な Cookie のみを使用しています。第三者による広告・行動追跡ツールは一切設置していません。\n## お客さまの権利\nアカウントにログインすることで、ご自身の注文履歴とイベント申込履歴をいつでもご確認いただけます。個人情報の開示・訂正・削除をご希望の場合は intervalbookstores@gmail.com までご連絡ください。ご本人確認のうえ対応いたします。\n## その他\nGoogle Maps や Instagram などの埋め込みサービスは、各社のポリシーに基づき利用情報を収集する場合があります。詳細は各サービスのプライバシーポリシーをご参照ください。本声明は運営状況により更新される場合があり、最新版は本ページに掲載します。",
  },
};

export const Route = createFileRoute("/privacy")({
  loader: async () => ({ page: await fetchPage("privacy") }),
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
      ],
    };
  },
  component: Privacy,
});

function Privacy() {
  const t = useT();
  const { page } = Route.useLoaderData();
  const p = pageText(page);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader eyebrow={page?.eyebrowPrefix ?? "Privacy"} title={t(p.title(PAGE.title))} />
      <section className="container-editorial pb-32 max-w-3xl">
        {/* 一段一行。開頭是「## 」的那一行是小標——政策文字夠長，全部塞進同一個
            <p> 會讓換行被壓成空白，讀者看到的是一整坨。分段的規則刻意留在這裡
            而不是拆成多個 CMS 欄位：後台改文案的人只要照著換行寫就好。 */}
        <div className="space-y-6">
          {t(p.block("body", PAGE.body))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, i) =>
              line.startsWith("## ") ? (
                <h2 key={i} className="pt-4 text-lg tracking-wide text-foreground">
                  {line.slice(3)}
                </h2>
              ) : (
                <p key={i} className="text-base leading-loose text-foreground/80">
                  {line}
                </p>
              ),
            )}
        </div>
      </section>
    </PageShell>
  );
}
