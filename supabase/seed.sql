-- =============================================================================
-- Interval Books / 小時光書店 — seed data
--
-- Mirrors, verbatim, the content that lives in the repo today:
--   src/data/content.ts   (events, exhibitions, journeys, news,
--                          curatedThemes + items, collaborations)
--   src/i18n/strings.ts   (UI, SITE_INFO, CONTACT_*, SOCIAL, MAP)
--   src/routes/*.tsx      (per-page meta + page copy + route-local lists)
--
-- Nothing here is invented. Where the current code renders the SAME string in
-- all three languages (a hard-coded Latin/Chinese label), the row repeats that
-- string across zh/en/ja so the rendered output is byte-identical after the
-- cutover. Those spots are flagged with `-- not localized in code today`.
--
-- Re-runnable: truncates the content tables first, so applying it twice yields
-- the same state. Run against a database that has 0001_init.sql applied.
-- =============================================================================

begin;

truncate table
  public.page_list_items,
  public.page_blocks,
  public.pages,
  public.collaborations,
  public.curated_items,
  public.curated_themes,
  public.news,
  public.journeys,
  public.exhibitions,
  public.events,
  public.event_categories,
  public.contact_phones,
  public.ui_strings,
  public.site_settings
  restart identity cascade;


-- site_settings ---------------------------------------------------------------
-- SITE_INFO / CONTACT_* / SOCIAL / MAP (src/i18n/strings.ts:59-107)
-- + site-wide <head> defaults (src/routes/__root.tsx:43-52)
insert into public.site_settings
  (short_desc, address, city, hours, closed, contact_email, site_url, social_instagram, social_facebook, social_line, map_embed, map_link, map_apple, meta_site_name, meta_author, meta_twitter_card, meta_og_type, default_meta_title, default_meta_description)
values
  ('{"zh":"小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。","en":"Set in the Red Brick Courtyard of Huashan 1914, Interval Books uses the bookstore as a vessel: starting from a local magazine, a reading circle or a cultural journey, we help more people discover the good things of Taiwan.","ja":"華山・紅煉瓦六合院にある小時光書店は、本屋をひとつの器として、一冊の地域誌、ひとつの読書会、ひとつの旅から、台湾のすてきなものをより多くの人に届けています。"}'::jsonb, '{"zh":"華山文創園區．紅磚六合院 西7-3館","en":"Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3","ja":"華山1914文化創意産業園區 紅煉瓦六合院 西7-3館"}'::jsonb, '{"zh":"台北市中正區","en":"Zhongzheng District, Taipei","ja":"台北市中正区"}'::jsonb, '{"zh":"週一至週日 11:00 – 19:00","en":"Mon – Sun, 11:00 – 19:00","ja":"月〜日 11:00 – 19:00"}'::jsonb, '{"zh":"每日開放（特殊節日另行公告）","en":"Open every day (special closures announced)","ja":"年中無休（特別休業は別途告知）"}'::jsonb, 'intervalbookstores@gmail.com', 'https://intervalbooks.tw', 'https://www.instagram.com/intervalbookstw/', '', '', 'https://www.google.com/maps?q=華山1914文化創意產業園區&output=embed', 'https://goo.gl/maps/RB2ep3NoWFenLamV9', 'https://maps.apple.com/?q=%E8%8F%AF%E5%B1%B11914%E6%96%87%E5%8C%96%E5%89%B5%E6%84%8F%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80&ll=25.0440,121.5298', '小時光書店 Interval Books', '小時光書店 Interval Books', 'summary_large_image', 'website', '小時光書店 Interval Books｜風土誌策展的閱讀與生活場域', '小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。');

-- ui_strings ------------------------------------------------------------------
-- The UI object, flattened: UI.<group_key>.<string_key> (src/i18n/strings.ts:4-57)
insert into public.ui_strings
  (group_key, string_key, value, sort_order)
values
  ('brand', 'brand', '{"zh":"小時光書店","en":"Interval Books","ja":"小時光書店"}'::jsonb, 1),
  ('brand', 'brandSub', '{"zh":"Interval Books","en":"Hourlight Bookstore","ja":"Interval Books"}'::jsonb, 2),
  ('nav', 'home', '{"zh":"首頁","en":"Home","ja":"ホーム"}'::jsonb, 1),
  ('nav', 'events', '{"zh":"活動","en":"Events","ja":"イベント"}'::jsonb, 2),
  ('nav', 'exhibitions', '{"zh":"展覽","en":"Exhibitions","ja":"展覧"}'::jsonb, 3),
  ('nav', 'journeys', '{"zh":"策旅","en":"Journeys","ja":"旅"}'::jsonb, 4),
  ('nav', 'curated', '{"zh":"主理人的選品","en":"Curated","ja":"店主の選品"}'::jsonb, 5),
  ('nav', 'visit', '{"zh":"來店資訊","en":"Visit","ja":"ご来店"}'::jsonb, 6),
  ('nav', 'about', '{"zh":"關於","en":"About","ja":"について"}'::jsonb, 7),
  ('nav', 'contact', '{"zh":"聯絡","en":"Contact","ja":"お問合せ"}'::jsonb, 8),
  ('nav', 'curation', '{"zh":"策展與合作","en":"Curation & Collaboration","ja":"キュレーション"}'::jsonb, 9),
  ('nav', 'privacy', '{"zh":"隱私權聲明","en":"Privacy","ja":"プライバシー"}'::jsonb, 10),
  ('footer', 'visit', '{"zh":"來訪","en":"Visit","ja":"ご来店"}'::jsonb, 1),
  ('footer', 'contact', '{"zh":"聯繫","en":"Contact","ja":"お問合せ"}'::jsonb, 2),
  ('footer', 'follow', '{"zh":"追蹤","en":"Follow","ja":"フォロー"}'::jsonb, 3),
  ('footer', 'aboutBlurb', '{"zh":"小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。","en":"Set in the Red Brick Courtyard of Huashan 1914, Interval Books uses the bookstore as a vessel: starting from a local magazine, a reading circle or a cultural journey, we help more people discover the good things of Taiwan.","ja":"華山・紅煉瓦六合院にある小時光書店は、本屋をひとつの器として、一冊の地域誌、ひとつの読書会、ひとつの旅から、台湾のすてきなものをより多くの人に届けています。"}'::jsonb, 4),
  ('footer', 'rights', '{"zh":"小時光書店．保留所有權利","en":"Interval Books. All rights reserved.","ja":"Interval Books. All rights reserved."}'::jsonb, 5),
  ('footer', 'everyday', '{"zh":"每日開放","en":"Open every day","ja":"年中無休"}'::jsonb, 6),
  ('buttons', 'toEvent', '{"zh":"前往活動網站","en":"Visit event site","ja":"イベントサイトへ"}'::jsonb, 1),
  ('buttons', 'toJourney', '{"zh":"前往旅程網站","en":"Visit journey site","ja":"旅のサイトへ"}'::jsonb, 2),
  ('buttons', 'toExhibition', '{"zh":"看展覽詳情","en":"View exhibition","ja":"展覧の詳細"}'::jsonb, 3),
  ('buttons', 'navigate', '{"zh":"點此導航","en":"Open in Maps","ja":"地図を開く"}'::jsonb, 4),
  ('buttons', 'emailUs', '{"zh":"Email 聯繫","en":"Email us","ja":"メールで問合せ"}'::jsonb, 5),
  ('buttons', 'line', '{"zh":"LINE 私訊","en":"Message on LINE","ja":"LINE で連絡"}'::jsonb, 6),
  ('buttons', 'inStore', '{"zh":"到店選購","en":"Visit in store","ja":"店頭でご覧"}'::jsonb, 7),
  ('buttons', 'viewAll', '{"zh":"查看全部","en":"View all","ja":"すべて見る"}'::jsonb, 8),
  ('buttons', 'backHome', '{"zh":"回到首頁","en":"Back home","ja":"ホームへ"}'::jsonb, 9),
  ('sections', 'thisMonth', '{"zh":"本月精選","en":"This Month","ja":"今月の特集"}'::jsonb, 1),
  ('sections', 'featuredEvents', '{"zh":"精選活動","en":"Featured Events","ja":"特選イベント"}'::jsonb, 2),
  ('sections', 'featuredExhibitions', '{"zh":"精選展覽","en":"Featured Exhibitions","ja":"特選展覧"}'::jsonb, 3),
  ('sections', 'featuredJourney', '{"zh":"精選策旅","en":"Featured Journey","ja":"特選の旅"}'::jsonb, 4),
  ('sections', 'latestNews', '{"zh":"最新消息","en":"Latest News","ja":"お知らせ"}'::jsonb, 5),
  ('notFound', 'title', '{"zh":"頁面尚未開放","en":"Page not found","ja":"ページが見つかりません"}'::jsonb, 1);

-- contact_phones --------------------------------------------------------------
insert into public.contact_phones
  (label, display_text, tel, sort_order)
values
  ('Tel', '+886 2 2341 6800', '+886223416800', 1),
  ('Mobile', '+886 917 540 615', '+886917540615', 2);

-- event_categories ------------------------------------------------------------
-- Order follows FILTERS (src/routes/events.tsx:48-56); labels from CATEGORY_LABEL.
insert into public.event_categories
  (id, label, sort_order)
values
  ('讀書會', '{"zh":"讀書會","en":"Reading Circles","ja":"読書会"}'::jsonb, 1),
  ('療癒生活節', '{"zh":"療癒生活節","en":"Healing Festival","ja":"ヒーリング祭"}'::jsonb, 2),
  ('策旅說明會', '{"zh":"策旅說明會","en":"Journey Briefings","ja":"旅の説明会"}'::jsonb, 3),
  ('陶藝家展售', '{"zh":"陶藝家展售","en":"Ceramicist Showcases","ja":"陶芸家の展示販売"}'::jsonb, 4),
  ('身心靈工作坊', '{"zh":"身心靈工作坊","en":"Mind & Body Workshops","ja":"心身ワークショップ"}'::jsonb, 5),
  ('好書交流', '{"zh":"好書交流","en":"Book Exchange","ja":"本の交流"}'::jsonb, 6);

-- events ----------------------------------------------------------------------
-- 活動一律由 /admin/events 後台建立（存檔時會連帶投影出 products 與場次，見 0026）。
-- 這裡不 seed 示範資料——舊的 ev-1/3/4/5/6 是 example.com 假資料，已於 2026-09-12 移除。

-- exhibitions -----------------------------------------------------------------
-- src/data/content.ts:211-262. image_key resolves the IMAGES map that currently
-- lives in src/routes/exhibitions.tsx:10-13 (ExhibitionItem.image was never set).
insert into public.exhibitions
  (id, slug, title, summary, description, period, location, image_key, sort_order)
values
  ('ex-1', 'soil-and-page', '{"zh":"土壤與書頁","en":"Soil and Page","ja":"土と頁"}'::jsonb, '{"zh":"六位地方書寫者與三位陶藝家，共構一場關於土地的閱讀。","en":"Six place-based writers and three ceramicists, on the reading of land.","ja":"六人の地方執筆者と三人の陶芸家による、土地をめぐる読書。"}'::jsonb, '{"zh":"本展以「風土」為線索，邀請文字與器物對話。書頁是被捻平的土地，陶土則是被烘烤的時間。我們希望觀者在閱讀與觸摸之間，重新感受腳下這片島嶼的紋理。","en":"Following the thread of terroir, words and vessels enter into conversation. The page is flattened earth, clay is fired time. We hope visitors feel, between reading and touching, the texture of this island anew.","ja":"「風土」を糸口に、言葉と器が静かに対話します。頁は均された大地、陶土は焼かれた時間。読み、触れるあいだに、この島の肌理をもう一度感じていただければ。"}'::jsonb, '2025.04.20 – 2025.06.15', '{"zh":"小時光書店．主展區","en":"Interval Books — Main Hall","ja":"小時光書店 メイン展示室"}'::jsonb, 'exhibition-corner.jpg', 1),
  ('ex-2', 'quiet-objects', '{"zh":"安靜的物件","en":"Quiet Objects","ja":"静かな物たち"}'::jsonb, '{"zh":"選物與作品，在留白之中各自發聲。","en":"Curated objects and works, each speaking softly within white space.","ja":"選び抜かれた品々が、余白のなかで静かに語りはじめる。"}'::jsonb, '{"zh":"策展團隊與三位設計師合作，挑選日用之器、文具與紙品。展期間每週末舉辦器物導讀，邀請觀者放慢腳步。","en":"In collaboration with three designers, selecting daily wares, stationery, and paper goods. Weekend object-readings throughout the run.","ja":"三人のデザイナーと協働し、日用の器、文具、紙ものを選びました。会期中は週末ごとに「物の読み聞かせ」を開催します。"}'::jsonb, '2025.07.05 – 2025.08.31', '{"zh":"小時光書店．東側書房","en":"Interval Books — East Reading Room","ja":"小時光書店 東側ブックルーム"}'::jsonb, 'storefront.jpg', 2);

-- journeys --------------------------------------------------------------------
-- 策旅一律由 /admin/journeys 後台建立（站內報名填 /events/… 路徑、外部策旅填完整網址）。
-- 這裡不 seed 示範資料——舊的 jo-1/2/3 是 example.com 假資料，已於 2026-09-12 移除。

-- news -----------------------------------------------------------------------
-- src/data/content.ts:348-406.
insert into public.news
  (id, title, summary, description, display_date, sort_order)
values
  ('n-1', '{"zh":"夏季展覽預告｜「安靜的物件」\n 媽媽的味道 即將開幕\n","en":"Summer preview: ''Quiet Objects'' opens soon","ja":"夏の展覧予告｜「静かな物たち」開幕"}'::jsonb, '{"zh":"我們將於5月推出新一檔策展，邀請三位設計師共同呈現日用之美。","en":"A new July show with three designers presenting the beauty of daily wares.","ja":"七月、三名のデザイナーと日用の美を呈する新展を開きます。"}'::jsonb, '{"zh":"展期 2025.07.05 – 2025.08.31，更多細節將陸續釋出。","en":"On view 2025.07.05 – 2025.08.31. More details to follow.","ja":"会期 2025.07.05 – 2025.08.31。詳細は順次公開します。"}'::jsonb, '2026.04.28', 1),
  ('n-2', '{"zh":"公告｜5/2, 5/16 包場，不對外開放","en":"Notice: Adjusted hours for the Dragon Boat holiday","ja":"営業時間のお知らせ｜端午節連休"}'::jsonb, '{"zh":"這2天沒有對外開放，敬請留意！\n需要訂書的朋友，請以官方Line聯繫。","en":"May 31 – Jun 2: closing at 17:00.","ja":"5/31 – 6/2 は 17:00 閉店となります。"}'::jsonb, '{"zh":"其餘時間維持原 11:00 – 19:00 營業。","en":"Otherwise open as usual, 11:00 – 19:00.","ja":"それ以外は通常通り 11:00 – 19:00 営業します。"}'::jsonb, '2026.05.02', 2),
  ('n-3', '{"zh":"策旅招募｜台東風土三日，04/30開放報名","en":"Journey open: Alishan three-day, signup May 15","ja":"旅の募集｜阿里山風土三日 5/15 受付開始"}'::jsonb, '{"zh":"由主理人帶隊，與在地職人、書寫者一同踏訪山海大地。","en":"Led by our owner with local tea makers and writers.","ja":"店主が引率、地元の茶人と書き手とともに山道を歩きます。"}'::jsonb, '{"zh":"限額 12 人，詳情請見策旅頁面。","en":"Limited to 12 guests. See Journeys for details.","ja":"定員12名。詳細は「旅」のページへ。"}'::jsonb, '2026.05.22–05.24', 3);

-- curated_themes / curated_items ----------------------------------------------
-- src/data/content.ts:408-514.
insert into public.curated_themes
  (id, title, description, sort_order)
values
  ('ct-1', '{"zh":"地方風土","en":"Place & Terroir","ja":"土地と風土"}'::jsonb, '{"zh":"從一本地方誌，到一罐自家熬的果醬。","en":"From a local journal to a jar of home-cooked jam.","ja":"地方誌から、自家製のジャムまで。"}'::jsonb, 1),
  ('ct-2', '{"zh":"器物與陶","en":"Vessels & Clay","ja":"器と陶"}'::jsonb, '{"zh":"每一只都是職人手中緩慢的時間。","en":"Each piece, the slow time of a maker''s hands.","ja":"ひとつひとつが、職人の手のなかの緩やかな時間。"}'::jsonb, 2),
  ('ct-3', '{"zh":"茶與日常","en":"Tea & Daily","ja":"茶と日々"}'::jsonb, '{"zh":"讀一頁書，配一口靜。","en":"A page of reading, a sip of quiet.","ja":"一頁の読書に、ひと口の静けさを。"}'::jsonb, 3);

-- curated_items：原本 18 件範例選品（蜂蜜、茶碗之類的示意品名）不是真的商品，2026-11-10 業主要求
-- 移除假資料，正式庫已刪除，這裡也不再種。真的選品由後台新增。

-- collaborations --------------------------------------------------------------
-- src/data/content.ts:517-566. Source has no ids; co-1..co-N assigned by order.
insert into public.collaborations
  (id, title, description, sort_order)
values
  ('co-1', '{"zh":"療癒藝術節／療癒師品牌共創","en":"Healing Arts Festivals & Practitioner Brands","ja":"ヒーリング・アートフェス／セラピスト共創"}'::jsonb, '{"zh":"為節慶與品牌設計具策展感的療癒現場。","en":"Curated healing experiences for festivals and brands.","ja":"祭典やブランドのために、キュレーションされたヒーリングの場を。"}'::jsonb, 1),
  ('co-2', '{"zh":"空間策展","en":"Space Curation","ja":"空間キュレーション"}'::jsonb, '{"zh":"為旅宿、咖啡館、辦公空間策劃選書與選物。","en":"Books and objects for hotels, cafés, and offices.","ja":"宿、カフェ、オフィスのための選書と選品。"}'::jsonb, 2),
  ('co-3', '{"zh":"書店展售／茶品器具內容策展","en":"Bookshop Showcase & Tea-ware Content","ja":"書店ショーケース／茶道具の内容企画"}'::jsonb, '{"zh":"結合書、茶與器物的主題內容策劃。","en":"Themed editorial pairings of books, tea, and vessels.","ja":"本、茶、器物を組み合わせたテーマ企画。"}'::jsonb, 3),
  ('co-4', '{"zh":"品牌共創","en":"Brand Co-creation","ja":"ブランド共創"}'::jsonb, '{"zh":"為品牌設計閱讀活動、內容資產與企業接待。","en":"Reading events, content, and hospitality for brands.","ja":"ブランドのための読書プログラム、コンテンツ、ホスピタリティ。"}'::jsonb, 4);

-- pages ----------------------------------------------------------------------
-- One row per src/routes/*.tsx (excluding __root). meta_* comes from the
-- useDocumentMeta({...}) call, header_* from <PageHeader>.
-- The eyebrow suffix on news / exhibitions / journeys / curation is hard-coded
-- Chinese in the JSX today, so it is seeded identically in all three languages
-- to preserve current output.  -- not localized in code today
insert into public.pages
  (slug, meta_title, meta_description, og_title, og_description, og_image_key, eyebrow_prefix, eyebrow_suffix, header_title, header_intro, sort_order)
values
  ('index', '{"zh":"小時光書店 Interval Books｜風土誌策展的閱讀與生活場域","en":"Interval Books｜A curated home for reading, terroir, and quiet life","ja":"小時光書店 Interval Books｜風土誌をキュレーションする読書と暮らしの場"}'::jsonb, '{"zh":"留一段屬於自己的＿＿＿小時光。","en":"Keep an interval that belongs only to you.","ja":"あなただけの小さな時間を、ひとつ。"}'::jsonb, '{"zh":"留一點時間給真正重要的事","en":"Save a little time for what truly matters.","ja":"本当に大切なことに、少しの時間を。"}'::jsonb, null, 'hero-mountain.jpg', null, null, null, null, 1),
  ('news', '{"zh":"最新消息 News｜小時光書店 Interval Books","en":"News｜Interval Books","ja":"お知らせ｜小時光書店 Interval Books"}'::jsonb, '{"zh":"活動預告、營業調整與策旅消息。","en":"Event announcements, opening updates, and journey news.","ja":"イベント予告、営業のお知らせ、旅の最新情報。"}'::jsonb, '{"zh":"最新消息","en":"Latest News","ja":"お知らせ"}'::jsonb, null, null, 'News', '{"zh":"最新消息","en":"最新消息","ja":"最新消息"}'::jsonb, '{"zh":"最新消息","en":"Latest News","ja":"お知らせ"}'::jsonb, '{"zh":"簡短的小通知與更新——展覽、活動、營業時間變動。","en":"Short notes and updates — exhibitions, events, and hours.","ja":"短いお知らせ。展覧、イベント、営業時間など。"}'::jsonb, 2),
  ('events', '{"zh":"活動 Events｜小時光書店 Interval Books","en":"Events｜Interval Books","ja":"イベント｜小時光書店 Interval Books"}'::jsonb, '{"zh":"讀書會、療癒生活節、策旅說明會、陶藝家展售、身心靈工作坊與好書交流——本頁為策展式彙整，每場活動皆有獨立網站。","en":"Reading circles, healing festivals, journey briefings, ceramicist showcases, somatic workshops, and book exchanges — a curated overview; each event has its own site.","ja":"読書会、ヒーリング・フェス、旅の説明会、陶芸家の展示販売、ソマティック・ワークショップ、本の交流。各イベントには専用サイトがあります。"}'::jsonb, '{"zh":"在書店相遇，走進台灣的土地","en":"Meet at the bookstore, step into Taiwan","ja":"本屋で出会い、台湾の土地へ"}'::jsonb, null, 'event-reading.jpg', 'Events', '{"zh":"活動","en":"Events","ja":"イベント"}'::jsonb, '{"zh":"在書店相遇，走進台灣的土地","en":"Meet at the bookstore, step into Taiwan","ja":"本屋で出会い、台湾の土地へ"}'::jsonb, '{"zh":"讀書會、講座、手作工作坊，還有走出書店的文化策旅。在這裡找一場想參加的，跟我們一起認識台灣的美好事物。","en":"Reading circles, talks, hands-on workshops, and cultural journeys beyond the shop. Find one that speaks to you and discover the good things of Taiwan with us.","ja":"読書会、トーク、ワークショップ、そして本屋の外へ出る文化の旅。気になるひとつを見つけて、台湾の素晴らしさを一緒に知りましょう。"}'::jsonb, 3),
  ('exhibitions', '{"zh":"展覽 Exhibitions｜小時光書店 Interval Books","en":"Exhibitions｜Interval Books","ja":"展覧｜小時光書店 Interval Books"}'::jsonb, '{"zh":"風土、文字、器物的策展現場——當期與下檔展覽彙整。","en":"A curated stage for terroir, words, and objects — current and upcoming exhibitions.","ja":"風土、ことば、器のキュレーション現場。開催中・予定の展覧をご紹介します。"}'::jsonb, '{"zh":"在書頁與展牆之間","en":"Between page and wall","ja":"頁と壁のあいだに"}'::jsonb, null, 'exhibition-corner.jpg', 'Exhibitions', '{"zh":"展覽","en":"展覽","ja":"展覽"}'::jsonb, '{"zh":"在書頁與展牆之間","en":"Between page and wall","ja":"頁と壁のあいだに"}'::jsonb, '{"zh":"我們以小型策展的節奏經營展覽，每一檔展覽都嘗試讓文字、影像與器物對話。","en":"We work in the rhythm of small curation — letting words, images, and objects speak together.","ja":"小さなキュレーションのリズムで、言葉、像、器がともに語り合う場をつくります。"}'::jsonb, 4),
  ('journeys', '{"zh":"策旅 Journeys｜小時光書店 Interval Books","en":"Journeys｜Interval Books","ja":"旅｜小時光書店 Interval Books"}'::jsonb, '{"zh":"由書與土地共同寫成的深度旅程。每一趟策旅皆有獨立網站，本頁為彙整導流。","en":"Slow journeys co-written by books and the land. Each trip has its own site; this page gathers the threads.","ja":"本と土地が共に綴る、深い旅。各旅には専用サイトがあります。このページはその目次です。"}'::jsonb, '{"zh":"讓土地，成為書的延伸","en":"Let the land be the book''s extension","ja":"土地を、本の延長に"}'::jsonb, null, 'journey-mist.jpg', 'Journeys', '{"zh":"策旅","en":"策旅","ja":"策旅"}'::jsonb, '{"zh":"讓土地，成為書的延伸","en":"Let the land be the book''s extension","ja":"土地を、本の延長に"}'::jsonb, '{"zh":"每一趟策旅皆有獨立網站，本頁僅做彙整導流。請點選感興趣的旅程，前往該旅程的專屬頁面。","en":"Each journey has its own dedicated site. Choose one to read further.","ja":"各「旅」には専用サイトがあります。気になる旅へお進みください。"}'::jsonb, 5),
  ('visit', '{"zh":"來店資訊 Visit｜小時光書店 Interval Books","en":"Visit｜Interval Books","ja":"ご来店｜小時光書店 Interval Books"}'::jsonb, '{"zh":"華山文創園區．紅磚六合院 西7-3館。週一至週日 11:00–19:00。捷運忠孝新生站步行 3 分鐘。","en":"Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3. Open daily 11:00–19:00. 3 min walk from MRT Zhongxiao Xinsheng.","ja":"華山1914文化創意産業園區 紅煉瓦六合院 西7-3館。月〜日 11:00–19:00。MRT 忠孝新生駅から徒歩3分。"}'::jsonb, '{"zh":"走進小時光","en":"Step inside the interval","ja":"小時光へ"}'::jsonb, null, null, 'Visit', '{"zh":"來店資訊","en":"Visit","ja":"ご来店"}'::jsonb, '{"zh":"走進小時光","en":"Step inside the interval","ja":"小時光へ"}'::jsonb, '{"zh":"一處藏在紅磚六合院裡的閱讀場域。歡迎在週間午後或週末傍晚，帶一本你正在讀的書，來坐一會兒。","en":"A reading space tucked inside the Red Brick Courtyard. Drop by on a quiet afternoon with the book you''re reading.","ja":"紅煉瓦六合院に佇む読書の場所。平日の午後や週末の夕暮れに、いま読んでいる本を抱えてお越しください。"}'::jsonb, 6),
  ('curated', '{"zh":"主理人的選品 Curated｜小時光書店 Interval Books","en":"Curated｜Interval Books","ja":"店主の選品｜小時光書店 Interval Books"}'::jsonb, '{"zh":"三個主題櫥窗：地方風土、器物與陶、茶與日常。展示型呈現，請至店或來信詢問。","en":"Three themed windows — place, vessels and clay, tea and daily life. A display, not a shop. Visit us or write to enquire.","ja":"三つのテーマの窓辺：土地の風土、器と陶、茶と日常。展示としてのご紹介です。店頭またはメールでお問い合わせください。"}'::jsonb, '{"zh":"主理人的選品","en":"The Owner''s Curated Window","ja":"店主の選品"}'::jsonb, null, 'curated-objects.jpg', 'Curated', '{"zh":"主理人的選品","en":"Curated","ja":"店主の選品"}'::jsonb, '{"zh":"主理人的選品","en":"The Owner''s Curated Window","ja":"店主の選品"}'::jsonb, '{"zh":"我們以「主題櫥窗」呈現選物，而非商品清單。每一件物，都是一段被留下來的時間。","en":"We arrange the selection as themed windows, not as a catalogue. Each piece holds a quiet stretch of time.","ja":"商品リストではなく、テーマの窓辺として並べています。一品一品が、留まった時間そのもの。"}'::jsonb, 7),
  ('curation', '{"zh":"策展與合作 Curation｜小時光書店 Interval Books","en":"Curation & Collaboration｜Interval Books","ja":"キュレーションと協働｜小時光書店 Interval Books"}'::jsonb, '{"zh":"療癒藝術節、空間策展、書店展售與品牌共創——以低調而精緻的方式，與夥伴共創。","en":"Healing arts festivals, spatial curation, in-store exhibitions, and quiet brand collaborations — co-created with care.","ja":"ヒーリング・アートフェス、空間キュレーション、店内展示、ブランド共創。静かで丁寧な協働を。"}'::jsonb, '{"zh":"與夥伴，共構一段現場","en":"Co-creating a quiet stage","ja":"ともに、ひとつの現場を"}'::jsonb, null, null, 'Curation', '{"zh":"策展與合作","en":"策展與合作","ja":"策展與合作"}'::jsonb, '{"zh":"與夥伴，共構一段現場","en":"Co-creating a quiet stage","ja":"ともに、ひとつの現場を"}'::jsonb, '{"zh":"我們相信策展不只是擺放，而是讓人、物、空間，在一段時間裡彼此看見。","en":"Curation, to us, is not arrangement — it''s letting people, objects, and space see one another for a while.","ja":"キュレーションとは並べることではなく、人と物と空間がしばらくのあいだ互いに見つめ合うこと。"}'::jsonb, 8),
  ('about', '{"zh":"關於 About｜小時光書店 Interval Books","en":"About｜Interval Books","ja":"について｜小時光書店 Interval Books"}'::jsonb, '{"zh":"小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。","en":"Set in the Red Brick Courtyard of Huashan 1914, Interval Books uses the bookstore as a vessel: starting from a local magazine, a reading circle or a cultural journey, we help more people discover the good things of Taiwan.","ja":"華山・紅煉瓦六合院にある小時光書店は、本屋をひとつの器として、一冊の地域誌、ひとつの読書会、ひとつの旅から、台湾のすてきなものをより多くの人に届けています。"}'::jsonb, '{"zh":"在華山的一段安靜時光","en":"A quiet interval in Huashan","ja":"華山の、しずかな小さき時間"}'::jsonb, null, 'bookstore-interior.jpg', 'About', '{"zh":"關於","en":"About","ja":"について"}'::jsonb, '{"zh":"在華山的一段安靜時光","en":"A quiet interval in Huashan","ja":"華山の、しずかな小さき時間"}'::jsonb, '{"zh":"小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。","en":"Set in the Red Brick Courtyard of Huashan 1914, Interval Books uses the bookstore as a vessel: starting from a local magazine, a reading circle or a cultural journey, we help more people discover the good things of Taiwan.","ja":"華山・紅煉瓦六合院にある小時光書店は、本屋をひとつの器として、一冊の地域誌、ひとつの読書会、ひとつの旅から、台湾のすてきなものをより多くの人に届けています。"}'::jsonb, 9),
  ('contact', '{"zh":"聯絡 Contact｜小時光書店 Interval Books","en":"Contact｜Interval Books","ja":"お問合せ｜小時光書店 Interval Books"}'::jsonb, '{"zh":"Email、Instagram、Facebook、LINE——歡迎與我們聯繫。","en":"Reach us via email, Instagram, Facebook, or LINE — we''d love to hear from you.","ja":"メール、Instagram、Facebook、LINE でお気軽にご連絡ください。"}'::jsonb, '{"zh":"請與我們聯繫","en":"Reach out","ja":"ご連絡ください"}'::jsonb, null, null, 'Contact', '{"zh":"聯絡","en":"Contact","ja":"お問合せ"}'::jsonb, '{"zh":"請與我們聯繫","en":"Reach out","ja":"ご連絡ください"}'::jsonb, '{"zh":"Email 是最直接的方式，我們會親自回覆。","en":"Email is the most direct way to reach us — we''ll reply personally.","ja":"メールが一番確実です。一通ずつお返事します。"}'::jsonb, 10),
  ('privacy', '{"zh":"隱私權 Privacy｜小時光書店 Interval Books","en":"Privacy｜Interval Books","ja":"プライバシー｜小時光書店 Interval Books"}'::jsonb, '{"zh":"小時光書店之隱私權聲明。","en":"Privacy statement of Interval Books.","ja":"小時光書店のプライバシーに関する声明。"}'::jsonb, '{"zh":"隱私權聲明","en":"Privacy Statement","ja":"プライバシー"}'::jsonb, null, null, 'Privacy', null, '{"zh":"隱私權聲明","en":"Privacy Statement","ja":"プライバシー"}'::jsonb, null, 11);

-- page_blocks -----------------------------------------------------------------
-- Standalone localized strings that currently sit in route files. block_key
-- mirrors the TS path, e.g. index.tsx HERO.titleSub -> 'hero.titleSub'.
-- 'visit.ig' is seeded for completeness: PAGE.ig is declared at visit.tsx:37
-- but never rendered.
insert into public.page_blocks
  (page_slug, block_key, value, sort_order)
values
  ('index', 'hero.eyebrow', '{"zh":"Interval Books  ／  Est.","en":"Interval Books  ／  Est.","ja":"Interval Books  ／  Est."}'::jsonb, 1),
  ('index', 'hero.titleMain', '{"zh":"小時光書店","en":"Interval Books","ja":"小時光書店"}'::jsonb, 2),
  ('index', 'hero.titleSub', '{"zh":"留一點時間給真正重要的事","en":"Save a little time for what truly matters.","ja":"本当に大切なことに、少しの時間を。"}'::jsonb, 3),
  ('index', 'hero.intro', '{"zh":"留一段屬於自己的＿＿＿小時光。","en":"Keep an interval that belongs only to you.","ja":"あなただけの小さな時間を、ひとつ。"}'::jsonb, 4),
  ('index', 'entries.explore', '{"zh":"Explore","en":"Explore","ja":"Explore"}'::jsonb, 5),
  ('index', 'entries.goTo', '{"zh":"前往","en":"Enter","ja":"見る"}'::jsonb, 6),
  ('index', 'entries.curatedTitle', '{"zh":"一本好書，一份心意，\n風帶不走了，都留在美好的人情連結裡。","en":"A window, not a shelf.","ja":"棚ではなく、窓辺に。"}'::jsonb, 7),
  ('index', 'entries.curatedBody', '{"zh":"關於這片土地的故事\n地方風土、器物與陶、茶與日常。\n都是被留下來的緩慢時間。","en":"Three themes, dozens of pieces — place, vessels, tea. Each one a quiet pause held in form.","ja":"三つのテーマ、数十の品. 土地, 器, 茶. それぞれが、留め置かれた緩やかな時間。"}'::jsonb, 8),
  ('index', 'entries.curatedCta', '{"zh":"走進選品櫥窗","en":"Enter the window","ja":"選品の窓辺へ"}'::jsonb, 9),
  ('index', 'entries.visitFull', '{"zh":"完整來訪資訊","en":"Full visit info","ja":"ご案内"}'::jsonb, 10),
  ('index', 'sections.exhibitionsEyebrow', '{"zh":"Exhibitions","en":"Exhibitions","ja":"Exhibitions"}'::jsonb, 11),
  ('index', 'sections.journeysEyebrow', '{"zh":"Journeys","en":"Journeys","ja":"Journeys"}'::jsonb, 12),
  ('index', 'sections.newsEyebrow', '{"zh":"News","en":"News","ja":"News"}'::jsonb, 13),
  ('events', 'filters.all', '{"zh":"全部","en":"All","ja":"すべて"}'::jsonb, 1),
  ('exhibitions', 'details', '{"zh":"展覽細節","en":"Exhibition details","ja":"展覧の詳細"}'::jsonb, 1),
  ('exhibitions', 'visitNote', '{"zh":"參觀方式 ／ 營業時間內自由參觀，無需預約","en":"Visit anytime during opening hours, no reservation needed.","ja":"営業時間内は予約不要で自由にご覧いただけます。"}'::jsonb, 2),
  ('journeys', 'coCreateEyebrow', '{"zh":"Co-create","en":"Co-create","ja":"Co-create"}'::jsonb, 1),
  ('journeys', 'collab', '{"zh":"策旅合作共創","en":"Journey co-creation","ja":"旅の共創"}'::jsonb, 2),
  ('journeys', 'collabBody', '{"zh":"若您是地方夥伴、職人、旅宿或品牌，歡迎與我們共創一段屬於風土的策旅。請以 Email 聯繫。","en":"If you''re a local partner, maker, hotel, or brand, we''d love to co-create a journey rooted in place. Reach us by email.","ja":"地域のパートナー、作り手、宿、ブランドの方へ。風土に根ざした旅をともに育てましょう。メールでご連絡ください。"}'::jsonb, 3),
  ('curated', 'windowLabel', '{"zh":"Window","en":"Window","ja":"Window"}'::jsonb, 1),
  ('curated', 'askPurchase', '{"zh":"詢問與選購","en":"Ask & purchase","ja":"お問合せ・お求め"}'::jsonb, 2),
  ('visit', 'address', '{"zh":"店址","en":"Address","ja":"ご住所"}'::jsonb, 1),
  ('visit', 'hours', '{"zh":"營業時間","en":"Hours","ja":"営業時間"}'::jsonb, 2),
  ('visit', 'transport', '{"zh":"交通方式","en":"Getting Here","ja":"アクセス"}'::jsonb, 3),
  ('visit', 'metro', '{"zh":"捷運","en":"Metro (MRT)","ja":"MRT"}'::jsonb, 4),
  ('visit', 'bus', '{"zh":"公車","en":"Bus","ja":"バス"}'::jsonb, 5),
  ('visit', 'drive', '{"zh":"開車・停車","en":"By car & parking","ja":"お車・駐車"}'::jsonb, 6),
  ('visit', 'walk', '{"zh":"步行路線","en":"On foot","ja":"徒歩でのご案内"}'::jsonb, 7),
  ('visit', 'inside', '{"zh":"店內體驗","en":"Inside","ja":"店内のこと"}'::jsonb, 8),
  ('visit', 'busDetail', '{"zh":"查看公車路線","en":"View bus routes","ja":"バス路線を見る"}'::jsonb, 9),
  ('visit', 'contactUs', '{"zh":"聯絡我們","en":"Contact us","ja":"お問合せ"}'::jsonb, 10),
  ('visit', 'ig', '{"zh":"Instagram","en":"Instagram","ja":"Instagram"}'::jsonb, 11),
  ('visit', 'navHint', '{"zh":"一鍵開啟導航，帶你走進紅磚六合院。","en":"One tap to open turn-by-turn navigation to the Red Brick Courtyard.","ja":"ワンタップで紅煉瓦六合院までのナビを開きます。"}'::jsonb, 12),
  ('visit', 'openGoogle', '{"zh":"Google Maps 導航","en":"Open in Google Maps","ja":"Google マップで開く"}'::jsonb, 13),
  ('visit', 'openApple', '{"zh":"Apple 地圖導航","en":"Open in Apple Maps","ja":"Apple マップで開く"}'::jsonb, 14),
  ('visit', 'navigateEyebrow', '{"zh":"Navigate","en":"Navigate","ja":"Navigate"}'::jsonb, 15),
  ('visit', 'contactEyebrow', '{"zh":"Contact","en":"Contact","ja":"Contact"}'::jsonb, 16),
  ('about', 'story', '{"zh":"從一櫃書、一張長桌開始，我們慢慢有了陶藝家的器物、地方夥伴的選物、與每月一場讀書會。書店並不大，但它是我們對於「閱讀」的長時間練習——讓書頁與生活，能彼此呼吸。","en":"We began with a single shelf and a long table. Then came the ceramicists'' vessels, the local partners'' selections, and a monthly reading circle. The shop is small, but it is our long practice of reading — letting page and life breathe together.","ja":"一棚の本と一脚の長机から始まりました。やがて陶芸家の器、地方の作り手の品、月に一度の読書会が加わりました。小さな店ですが、本と暮らしがともに呼吸できる場をめざす、長い練習なのです。"}'::jsonb, 1),
  ('about', 'workTitle', '{"zh":"我們做的事","en":"What we do","ja":"わたしたちのしごと"}'::jsonb, 2),
  ('about', 'spaceTitle', '{"zh":"空間特色","en":"Inside the space","ja":"空間"}'::jsonb, 3),
  ('contact', 'email', '{"zh":"Email","en":"Email","ja":"メール"}'::jsonb, 1),
  ('contact', 'phone', '{"zh":"電話","en":"Phone","ja":"お電話"}'::jsonb, 2),
  ('contact', 'social', '{"zh":"社群","en":"Follow","ja":"フォロー"}'::jsonb, 3),
  ('contact', 'site', '{"zh":"官方網站","en":"Website","ja":"公式サイト"}'::jsonb, 4),
  ('curation', 'contactEyebrow', '{"zh":"Contact","en":"Contact","ja":"Contact"}'::jsonb, 1),
  ('curation', 'contact', '{"zh":"合作邀請請以 Email 聯繫，我們會親自回覆。","en":"For collaboration, please reach us by email — we''ll reply personally.","ja":"ご相談はメールにて。一通ずつお返事いたします。"}'::jsonb, 2),
  ('privacy', 'body', '{"zh": "小時光書店尊重每一位讀者與顧客的個人資訊。本頁說明我們實際會收集什麼、用在哪裡、又交給了誰。\n## 我們會收集的資料\n訂購與報名：姓名、Email、電話、收件地址（宅配或超商門市），以及您為參加者填寫的姓名與聯絡方式。\n會員帳號：Email 與密碼。密碼以雜湊形式保存，我們無法讀取您的原始密碼。\n發票資訊：您選擇的載具、統一編號或抬頭。\n## 我們不會保存的資料\n信用卡號與卡片背面的安全碼。刷卡是在金流服務商的頁面上完成，卡號不會經過本站，我們也沒有保存。\n## 我們會把資料交給誰\n為了完成您的訂單，以下服務會取得必要範圍內的資料：統一客樂得「黑貓 PAY」與統一金流 PAYUNi（處理付款）、Amego（依法開立電子發票）、Resend（寄送訂單與活動通知信）、Supabase 與 Vercel（資料儲存與網站代管）、物流或超商業者（配送您選擇的取貨方式）。除了完成訂單所必需的範圍，我們不會將您的資料販售或提供給任何第三方。\n## 保存期間\n訂單與發票屬會計憑證，依稅法規定之期限保存。通知信的內文會在寄出滿三十天後自動清除，之後只留下寄送紀錄。\n## Cookie\n本站使用維持登入狀態與購物車所必需的 cookie。本站沒有安裝任何第三方廣告或行為追蹤工具。\n## 您的權利\n您可以隨時登入帳號，查看自己的訂單與活動報名紀錄。若要查詢、更正或刪除您的個人資料，請來信 info@intervalbooks.tw，我們會在確認身分後為您處理。\n## 其他\n第三方嵌入服務（如 Google Maps、Instagram）可能依其自身政策蒐集使用紀錄，請參閱該服務之隱私聲明。本聲明可能依實際營運狀況更新，更新版本將直接公佈於本頁。", "en": "Interval Books respects the privacy of every reader and customer. This page sets out what we actually collect, what we use it for, and who we pass it to.\n## What we collect\nOrders and event registrations: name, email, phone, delivery address (home delivery or convenience-store pickup), and the names and contact details you enter for each participant.\nMember accounts: email and password. Passwords are stored as hashes; we cannot read your original password.\nInvoice details: the carrier, tax ID, or title you choose.\n## What we do not keep\nCard numbers and security codes. Payment is completed on the payment provider''s own page — card numbers never pass through this site and we do not store them.\n## Who receives your data\nTo complete your order, the following services receive only what they need: President Collect \"Black Cat PAY\" and PAYUNi (payment processing), Amego (statutory e-invoicing), Resend (order and event notification emails), Supabase and Vercel (data storage and hosting), and the courier or convenience-store operator handling your chosen delivery method. Beyond what is required to complete your order, we do not sell or pass your data to any third party.\n## How long we keep it\nOrders and invoices are accounting records and are kept for the period required by tax law. The body text of notification emails is automatically purged thirty days after sending; only the delivery record remains.\n## Cookies\nThis site uses only the cookies required to keep you signed in and to hold your cart. No third-party advertising or behavioural tracking tools are installed.\n## Your rights\nYou can sign in at any time to view your own orders and event registrations. To access, correct, or delete your personal data, write to info@intervalbooks.tw and we will act on it once we have verified your identity.\n## Other\nThird-party embeds (such as Google Maps and Instagram) may collect usage data under their own policies; please see those services'' notices. This statement may be updated as operations evolve, and any new version will be posted on this page.", "ja": "小時光書店は、読者とお客さまおひとりおひとりの個人情報を尊重します。本ページでは、実際に取得する情報、その利用目的、および提供先について説明します。\n## 取得する情報\nご注文・イベント申込：お名前、メールアドレス、電話番号、お届け先住所（宅配またはコンビニ受取）、および参加者ごとにご入力いただくお名前と連絡先。\n会員アカウント：メールアドレスとパスワード。パスワードはハッシュ化して保管しており、元のパスワードを当店が読み取ることはできません。\nインボイス情報：お選びいただいたキャリア、統一番号、または宛名。\n## 保管しない情報\nクレジットカード番号およびセキュリティコード。決済は決済事業者のページ上で完了し、カード番号が当サイトを経由することはなく、保管もしていません。\n## 提供先\nご注文の履行のため、以下のサービスが必要な範囲の情報を取得します：統一客樂得「黑貓 PAY」および統一金流 PAYUNi（決済処理）、Amego（法令に基づく電子インボイス発行）、Resend（注文・イベント通知メールの送信）、Supabase および Vercel（データ保管とホスティング）、配送業者またはコンビニ事業者（お選びの受取方法での配送）。ご注文の履行に必要な範囲を超えて、お客さまの情報を販売または第三者に提供することはありません。\n## 保管期間\nご注文とインボイスは会計帳簿として、税法が定める期間保管します。通知メールの本文は送信から三十日後に自動的に削除され、以後は送信記録のみが残ります。\n## Cookie\n本サイトでは、ログイン状態の維持とカートの保持に必要な Cookie のみを使用しています。第三者による広告・行動追跡ツールは一切設置していません。\n## お客さまの権利\nアカウントにログインすることで、ご自身の注文履歴とイベント申込履歴をいつでもご確認いただけます。個人情報の開示・訂正・削除をご希望の場合は info@intervalbooks.tw までご連絡ください。ご本人確認のうえ対応いたします。\n## その他\nGoogle Maps や Instagram などの埋め込みサービスは、各社のポリシーに基づき利用情報を収集する場合があります。詳細は各サービスのプライバシーポリシーをご参照ください。本声明は運営状況により更新される場合があり、最新版は本ページに掲載します。"}'::jsonb, 1);

-- page_list_items -------------------------------------------------------------
-- index.tsx three entry cards (label + desc), visit.tsx METRO/WALK/DRIVE/BUS/
-- INSIDE (visit.tsx:47-135), about.tsx WORK (title + desc) and SPACE (label +
-- image). The visit.tsx lists are stored per language in code and are re-joined
-- here index-by-index into one Localized row each.
insert into public.page_list_items
  (page_slug, list_key, label, note, image_key, sort_order)
values
  ('index', 'entryCards', '{"zh":"看活動","en":"Events","ja":"イベント"}'::jsonb, '{"zh":"讀書會、講座、工作坊與身心靈活動。","en":"Reading circles, talks, workshops, and healing practice.","ja":"読書会、トーク、ワークショップ、ヒーリング。"}'::jsonb, null, 1),
  ('index', 'entryCards', '{"zh":"看策旅","en":"Journeys","ja":"旅"}'::jsonb, '{"zh":"由書與土地共同寫成的深度旅程。","en":"Slow journeys co-written by books and the land.","ja":"本と土地が共に綴る、深い旅。"}'::jsonb, null, 2),
  ('index', 'entryCards', '{"zh":"來店資訊","en":"Visit","ja":"ご来店"}'::jsonb, '{"zh":"華山，紅磚六合院，西7-3館。","en":"Huashan, Red Brick Courtyard, West 7-3.","ja":"華山、紅煉瓦六合院、西7-3館。"}'::jsonb, null, 3),
  ('visit', 'metro', '{"zh":"板南線「忠孝新生站」1 號出口，步行約 3 分鐘","en":"Bannan Line, Zhongxiao Xinsheng Station, Exit 1 — about 3 min on foot","ja":"板南線「忠孝新生」駅 1 番出口より徒歩約 3 分"}'::jsonb, null, null, 1),
  ('visit', 'metro', '{"zh":"或「善導寺站」6 號出口，步行約 5 分鐘","en":"Or Shandao Temple Station, Exit 6 — about 5 min on foot","ja":"または「善導寺」駅 6 番出口より徒歩約 5 分"}'::jsonb, null, null, 2),
  ('visit', 'walk', '{"zh":"從忠孝新生站 1 號出口出來，沿金山北路向北步行約 200 公尺。","en":"From MRT Zhongxiao Xinsheng Exit 1, walk north on Jinshan N. Rd. for ~200 m.","ja":"忠孝新生駅 1 番出口から金山北路を北へ約 200 m。"}'::jsonb, null, null, 1),
  ('visit', 'walk', '{"zh":"看到紅磚老建築群即進入園區，沿主道走至「紅磚六合院」。","en":"Enter the park when you see the red-brick warehouses, then head to the Red Brick Courtyard.","ja":"赤煉瓦倉庫群が見えたら園内へ。メイン通りに沿って「紅煉瓦六合院」へ。"}'::jsonb, null, null, 2),
  ('visit', 'walk', '{"zh":"穿過六合院中庭，西側第三間即為「西 7-3 館」。","en":"Cross the courtyard — West 7-3 is the third unit on the west side.","ja":"中庭を抜けた西側 3 番目が「西 7-3 館」です。"}'::jsonb, null, null, 3),
  ('visit', 'drive', '{"zh":"園區附設 24 小時停車場（出入口位於八德路一段）","en":"On-site 24-hour parking lot (entrance on Bade Rd. Sec. 1)","ja":"園内に 24 時間駐車場あり（入口は八德路一段）"}'::jsonb, null, null, 1),
  ('visit', 'drive', '{"zh":"平日 TWD 40 ／小時　|　假日 TWD 60 ／小時","en":"Weekdays TWD 40 / hr  ·  Weekends TWD 60 / hr","ja":"平日 TWD 40 / 時　|　休日 TWD 60 / 時"}'::jsonb, null, null, 2),
  ('visit', 'drive', '{"zh":"建議：假日車位緊張，可改搭捷運前往。","en":"Tip: weekend parking fills quickly — MRT is recommended.","ja":"ヒント：週末は満車になりやすいため、MRT のご利用がおすすめです。"}'::jsonb, null, null, 3),
  ('visit', 'bus', '{"zh":"忠孝國小站：232、232(副)、605 系列、665","en":"Zhongxiao Elementary School stop (忠孝國小): 232, 232(sub), 605 series, 665","ja":"忠孝國小停留所：232、232(副)、605 系統、665"}'::jsonb, null, null, 1),
  ('visit', 'bus', '{"zh":"華山公園站：669","en":"Huashan Park stop (華山公園): 669","ja":"華山公園停留所：669"}'::jsonb, null, null, 2),
  ('visit', 'bus', '{"zh":"審計部（忠孝東路）：205、232、262(區間)、276、299、忠孝新幹線","en":"National Audit Office on Zhongxiao E. Rd. (審計部): 205, 232, 262(local), 276, 299, Zhongxiao Express","ja":"審計部（忠孝東路）停留所：205、232、262(区間)、276、299、忠孝新幹線"}'::jsonb, null, null, 3),
  ('visit', 'inside', '{"zh":"自選茶點與小份量甜食","en":"Self-serve tea and small sweets","ja":"セルフのお茶と小ぶりな甘いもの"}'::jsonb, null, null, 1),
  ('visit', 'inside', '{"zh":"安靜閱讀座位（請小聲交談）","en":"Quiet reading seats (please keep voices low)","ja":"静かな読書席（小声でどうぞ）"}'::jsonb, null, null, 2),
  ('visit', 'inside', '{"zh":"不定期舉辦讀書會、講座與身心靈活動","en":"Occasional reading circles, talks, and healing sessions","ja":"読書会、トーク、ヒーリングを随時開催"}'::jsonb, null, null, 3),
  ('visit', 'inside', '{"zh":"可詢問主理人選書與選品建議","en":"Ask the owner for book and object recommendations","ja":"店主におすすめの本や品をお気軽にご相談ください"}'::jsonb, null, null, 4),
  ('about', 'work', '{"zh":"風土誌策展","en":"Terroir Curation","ja":"風土誌キュレーション"}'::jsonb, '{"zh":"以地方為線索，策劃書展、選物與內容。","en":"Place as the thread for book shows, objects, and content.","ja":"土地を糸口に、書展・選品・コンテンツを編む。"}'::jsonb, null, 1),
  ('about', 'work', '{"zh":"活動與讀書會","en":"Events & Reading Circles","ja":"イベントと読書会"}'::jsonb, '{"zh":"讀書會、講座、工作坊、身心靈活動。","en":"Reading circles, talks, workshops, and healing practice.","ja":"読書会、トーク、ワークショップ、ヒーリング。"}'::jsonb, null, 2),
  ('about', 'work', '{"zh":"策旅與合作共創","en":"Journeys & Co-creation","ja":"旅と共創"}'::jsonb, '{"zh":"與在地夥伴設計風土主題旅程與品牌共創。","en":"Place-rooted journeys and brand co-creation with local partners.","ja":"地のパートナーと風土の旅、ブランド共創を設計します。"}'::jsonb, null, 3),
  ('about', 'space', '{"zh":"書","en":"Books","ja":"本"}'::jsonb, null, 'bookstore-interior.jpg', 1),
  ('about', 'space', '{"zh":"選品","en":"Objects","ja":"選品"}'::jsonb, null, 'curated-objects.jpg', 2),
  ('about', 'space', '{"zh":"策展","en":"Exhibitions","ja":"展覧"}'::jsonb, null, 'exhibition-corner.jpg', 3);

commit;

-- Expected row counts after this seed:
--   site_settings        1
--   ui_strings          33
--   contact_phones       2
--   event_categories     6
--   events               6
--   exhibitions          2
--   journeys             3
--   news                 3
--   curated_themes       3
--   curated_items        0
--   collaborations       4
--   pages               11
--   page_blocks         47
--   page_list_items     24
