/**
 * 《范毅舜公東教堂文化之旅》著陸頁的靜態章節。
 *
 * 由業主 Lovable 參考站（www.kungtung.intervalbooks.tw）伺服器輸出的 HTML 逐節轉成 JSX：
 * 文字、順序、標籤結構照原站，自訂 class 加 kt- 前綴（樣式在 kungtung.css），圖片換成
 * 站上 site-images 的那 16 張（images.ts）。報名、願望募集、手機底部列三塊有互動，
 * 寫在 src/routes/events.kungtung.tsx。
 *
 * ⚠️ 內容寫死在這裡，後台改不到；/admin 改這一場只影響列表卡片與結帳品項名稱。
 */
import { IMG } from "./images";

export function SkipLink() {
  return (
    <a href="#register" className="kt-skip-link">
      跳至報名表單
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="kt-site-header">
      <a href="#top" className="kt-brand-mark">
        <img
          src={IMG["interval-logo"]}
          alt="Interval Books 品牌 Logo"
          width="405"
          height="405"
          className="kt-brand-logo"
        />
        <span>
          INNTERVAL
          <span className="block text-xs font-sans">小時光 文化策旅</span>
        </span>
      </a>
      <nav aria-label="頁面導覽">
        <a
          href="#story"
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary underline-offset-4 hover:underline h-9 px-4 py-2"
        >
          旅程緣起
        </a>
        <a
          href="#itinerary"
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary underline-offset-4 hover:underline h-9 px-4 py-2"
        >
          三日旅程
        </a>
        <a
          href="#price"
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary underline-offset-4 hover:underline h-9 px-4 py-2"
        >
          費用
        </a>
        <a
          href="#register"
          className="items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 hidden sm:inline-flex"
        >
          預約旅程
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="lucide lucide-arrow-up-right"
            aria-hidden="true"
          >
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </a>
      </nav>
    </header>
  );
}

export function Hero() {
  return (
    <section id="top" className="kt-cinematic-hero">
      <img
        src={IMG["gudong-church-interior"]}
        alt="公東教堂內部實景：清水模天花、木製長椅與彩色玻璃窗"
        width="1402"
        height="1126"
        fetchPriority="high"
        className="kt-hero-photo"
      />
      <div className="kt-bg-hero-overlay absolute inset-0"></div>
      <div className="kt-editorial-container kt-hero-content">
        <p className="kt-hero-date">2026.11.14–11.16｜台東・三天兩夜</p>
        <p className="kt-hero-name">范毅舜公東教堂文化之旅</p>
        <h1>
          有些故事，
          <br />
          值得親自走進去。
        </h1>
        <p className="kt-hero-description">
          跟著范毅舜讀懂一座教堂，
          <br className="sm:hidden" />
          跟著 Alice 感受一種生活。
        </p>
        <div className="kt-hero-author">
          <img src={IMG["fan-yishun-portrait"]} alt="文化領路人范毅舜" width="1409" height="1920" />
          <span>
            范毅舜 親自導覽
            <span className="block text-xs mt-1">文化深度 × 生活美學 × 沙龍交流</span>
          </span>
        </div>
        <div className="kt-hero-actions">
          <a
            href="#register"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 kt-journey-button"
          >
            預約這趟文化旅程
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="lucide lucide-arrow-up-right"
              aria-hidden="true"
            >
              <path d="M7 7h10v10" />
              <path d="M7 17 17 7" />
            </svg>
          </a>
          <a
            href="#itinerary"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 kt-journey-button kt-hero-secondary"
          >
            探索三日旅程
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="lucide lucide-arrow-down"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </a>
        </div>
      </div>
      <div className="kt-hero-folio">
        <span aria-hidden="true">TAITUNG / CULTURE & LIFE</span>
        <span className="kt-hero-credit">策劃單位：小時光風土誌書店</span>
      </div>
    </section>
  );
}

export function Story() {
  return (
    <section id="story" className="kt-section-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">THE STORY / 旅程緣起</p>
        <div className="kt-story-heading">
          <h2 className="kt-section-title">
            一座教堂，為什麼值得
            <br className="hidden md:block" />
            一個人長年記錄？
          </h2>
          <p className="kt-body-copy">
            范毅舜以鏡頭與文字，長年記錄台灣土地與歐洲的人文風景。《公東的教堂》寫下這座教堂與公東高工的教育故事，正是這趟旅程的起點。第一晚，從書中的故事說起；第二天，走進光影中的現場。
          </p>
        </div>
        <div className="mt-16 grid gap-6 sm:grid-cols-2">
          <figure className="border border-border bg-card px-6 pb-6 pt-8 sm:col-span-2">
            <div className="grid grid-cols-2 items-center justify-items-center gap-3 sm:gap-6">
              <img
                src={IMG["gongdong_chapel_cover_stone"]}
                alt="《公東的教堂》十周年紀念版書封之一"
                className="w-full max-w-[200px] sm:max-w-[240px]"
                loading="lazy"
              />
              <img
                src={IMG["gongdong_chapel_cover_glass"]}
                alt="《公東的教堂》十周年紀念版書封之二，彩色玻璃"
                className="w-full max-w-[200px] sm:max-w-[240px]"
                loading="lazy"
              />
            </div>
            <figcaption className="mt-6 text-center">
              <p className="text-base sm:text-lg">《公東的教堂》</p>
              <p className="mt-1.5 text-xs text-muted-foreground sm:text-sm">
                十周年紀念版・雙書封
              </p>
            </figcaption>
          </figure>
          <figure className="border border-border bg-card px-6 pb-6 pt-8">
            <div className="grid grid-cols-2 items-center justify-items-center gap-2 sm:gap-3">
              <img
                src={IMG["convent_on_the_hill_cover_wall"]}
                alt="《山丘上的修道院》書封"
                className="w-full max-w-[120px] sm:max-w-[150px]"
                loading="lazy"
              />
              <img
                src={IMG["convent_on_the_hill_cover_night"]}
                alt="《山丘上的修道院》另一種書封"
                className="w-full max-w-[120px] sm:max-w-[150px]"
                loading="lazy"
              />
            </div>
            <figcaption className="mt-6 text-center">
              <p className="text-base">《山丘上的修道院》</p>
              <p className="mt-1.5 text-xs text-muted-foreground">科比意的最後風景</p>
            </figcaption>
          </figure>
          <figure className="border border-border bg-card px-6 pb-6 pt-8">
            <img
              src={IMG["walk_into_cathedral_cover"]}
              alt="《走進一座大教堂》書封"
              className="mx-auto w-full max-w-[180px] sm:max-w-[200px]"
              loading="lazy"
            />
            <figcaption className="mt-6 text-center">
              <p className="text-base">《走進一座大教堂》</p>
              <p className="mt-1.5 text-xs text-muted-foreground">德法文化遺產</p>
            </figcaption>
          </figure>
          <figure className="flex flex-col items-center justify-center border border-border bg-card px-6 pb-6 pt-8">
            <img
              src={IMG["coastal_range_swiss_spread"]}
              alt="《海岸山脈的瑞士人》書封，海岸山脈山景與一封白冷會士的家書"
              className="mx-auto w-full max-w-[440px]"
              width={1200}
              height={898}
              loading="lazy"
            />
            <figcaption className="mt-6 text-center">
              <p className="text-base">《海岸山脈的瑞士人》</p>
              <p className="mt-1.5 text-xs text-muted-foreground">用真心付出的動人故事</p>
            </figcaption>
          </figure>
          <figure className="flex flex-col items-center justify-center border border-border bg-card px-6 pb-6 pt-8">
            <img
              src={IMG["yetaixi_cover"]}
              alt="《野台戲》書封"
              className="mx-auto w-full max-w-[180px] sm:max-w-[200px]"
              width={803}
              height={1200}
              loading="lazy"
            />
            <figcaption className="mt-6 text-center">
              <p className="text-base">《野台戲》</p>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

export function Values() {
  return (
    <section className="kt-values-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">FOUR WAYS TO CONNECT / 旅程的四種深度</p>
        <div className="kt-values-grid">
          <article>
            <div className="flex justify-between items-center">
              <span className="font-serif text-sm">01</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="23"
                height="23"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-book-open"
                aria-hidden="true"
              >
                <path d="M12 7v14" />
                <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
              </svg>
            </div>
            <h3>文化深度</h3>
            <p>跟著范毅舜的鏡頭與文字，從閱讀走向實地，在建築裡看見人文。</p>
          </article>
          <article>
            <div className="flex justify-between items-center">
              <span className="font-serif text-sm">02</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="23"
                height="23"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-compass"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
              </svg>
            </div>
            <h3>生命故事</h3>
            <p>從《公東的教堂》出發，聆聽教堂、公東高工與土地之間的連結。</p>
          </article>
          <article>
            <div className="flex justify-between items-center">
              <span className="font-serif text-sm">03</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="23"
                height="23"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-coffee"
                aria-hidden="true"
              >
                <path d="M10 2v2" />
                <path d="M14 2v2" />
                <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
                <path d="M6 2v2" />
              </svg>
            </div>
            <h3>小時光的文化策展 × 馥自然的生活美學</h3>
            <p>由小時光的文化策展能力，結合馥自然的生活美學場域，共同成就這趟旅程。</p>
          </article>
          <article>
            <div className="flex justify-between items-center">
              <span className="font-serif text-sm">04</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="23"
                height="23"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-music2 lucide-music-2"
                aria-hidden="true"
              >
                <circle cx="8" cy="18" r="4" />
                <path d="M12 18V2l7 4" />
              </svg>
            </div>
            <h3>深度交流</h3>
            <p>夜間沙龍與黑膠音樂相伴，留出自在對話、彼此相遇的時間。</p>
          </article>
        </div>
      </div>
    </section>
  );
}

export function Hosts() {
  return (
    <section id="hosts" className="kt-section-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">YOUR HOSTS / 旅程主理人</p>
        <h2 className="kt-section-title">
          一位說故事的人，
          <br />
          一位安排生活的人。
        </h2>
        <div className="kt-hosts-grid">
          <article className="kt-host-profile">
            <img
              src={IMG["fan-yishun-portrait"]}
              width="1409"
              height="1920"
              alt="攝影作家范毅舜的真實肖像"
              loading="lazy"
            />
            <div>
              <p className="kt-host-eyebrow">
                <span className="kt-host-eyebrow-en">THE GUIDE</span>
                <span className="kt-host-eyebrow-zh">這趟旅程的領路人</span>
              </p>
              <h3>
                范毅舜
                <span className="kt-host-role">｜文化領路人</span>
              </h3>
              <p className="kt-host-introduction">帶領旅人走進建築背後的文化與生命故事。</p>
              <p className="kt-body-copy">
                攝影作家，以影像與文字記錄建築、土地與人的故事。瑞典哈蘇曾推崇為全球 150
                位優秀攝影家之一，作品曾於美國華府參議院展出，並獲《華盛頓郵報》半版報導。這一次，從《公東的教堂》的閱讀出發，親自帶領旅人走入教堂，讓眼前的光影與生命故事相互照映。
              </p>
              <div className="kt-host-home-media">
                <p className="kt-host-home-media-label">他的故事，曾被這樣報導</p>
                <a
                  href="https://seeds.com.tw/en/blog/nicholas-fan"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  「攝影，是你端詳這個世界的方式。」——學籽專訪
                </a>
                <a
                  href="https://www.gfc.org.tw/project-news/3955"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  從歐洲文化遺產到公東的教堂——大唐人文講座
                </a>
                <a
                  href="https://www.lac.org.tw/eventbulletin/20130509-5584-1502068385"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  大愛電視《愛悅讀》，一路走讀公東的教堂
                </a>
              </div>
              <a className="kt-host-more-link" href="/events/kungtung/hosts/fan-yishun">
                閱讀范毅舜的完整經歷、著作與報導
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-arrow-up-right"
                  aria-hidden="true"
                >
                  <path d="M7 7h10v10" />
                  <path d="M7 17 17 7" />
                </svg>
              </a>
            </div>
          </article>
          <article className="kt-alice-feature" aria-labelledby="alice-name">
            <figure className="kt-alice-portrait">
              <img
                src={IMG["alice-portrait-tea"]}
                alt="Alice 劉柳樺於文化茶席間，微笑手捧茶杯"
                width="1420"
                height="1542"
                loading="lazy"
              />
            </figure>
            <div className="kt-alice-feature-copy">
              <p className="kt-host-eyebrow">
                <span className="kt-host-eyebrow-en">THE HOST</span>
                <span className="kt-host-eyebrow-zh">這趟旅程的款待者</span>
              </p>
              <h3 id="alice-name" className="kt-alice-name">
                Alice 劉柳樺
              </h3>
              <p className="kt-alice-subtitle">小時光風土誌書店主理人 × 馥自然人文空間策旅主理人</p>
              <blockquote className="kt-alice-quote">
                把文化帶進生活，
                <br />
                把相遇變成值得珍藏的記憶。
              </blockquote>
              <p className="kt-alice-text">
                從台北華山的小時光風土誌書店，到台東山海間的馥自然，Alice
                始終相信，文化不只存在於書本與展覽之中，也存在於一席餐桌、建築、音樂，以及人與人真誠相遇的時刻。
              </p>
              <p className="kt-alice-text">
                這一次，她邀請攝影作家范毅舜，以公東教堂的建築與生命故事為起點，親自策劃三天兩夜的山海文化之旅。
              </p>
              <p className="kt-alice-text">
                不只是帶大家去看一座教堂，更希望每位旅人，都能帶著新的感動回到生活。
              </p>
              <a className="kt-host-more-link" href="/events/kungtung/hosts/alice">
                閱讀 Alice 的完整經歷
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-arrow-up-right"
                  aria-hidden="true"
                >
                  <path d="M7 7h10v10" />
                  <path d="M7 17 17 7" />
                </svg>
              </a>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

export function Moments() {
  return (
    <section className="kt-moments-band kt-section-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">MOMENTS TO REMEMBER / 四個難忘時刻</p>
        <h2 className="kt-section-title">把時間，留給這些相遇。</h2>
        <div className="kt-moments-grid">
          <article>
            <img
              src={IMG["gongdong_chapel_cover_glass"]}
              alt="《公東的教堂》書封，夜間沙龍的閱讀起點"
              loading="lazy"
              className="kt-moment-book"
            />
            <p>11.14 / 20:00</p>
            <h3>公東的教堂｜夜間沙龍</h3>
            <span>從一本書，走近一座教堂的故事。</span>
          </article>
          <article>
            <img
              src={IMG["gudong-church-interior"]}
              alt="公東教堂彩色玻璃與木製長椅，導覽場域實景"
              loading="lazy"
            />
            <p>11.15 / 14:30</p>
            <h3>范毅舜｜親自導覽</h3>
            <span>在現場，讀懂建築與生命的對話。</span>
          </article>
          <article>
            <img
              src={IMG["funature-dish"]}
              alt="莫子主廚料理實拍，非本次活動固定菜單"
              loading="lazy"
            />
            <p>11.14 / 18:00</p>
            <h3>莫子｜山海套餐</h3>
            <span>以在地風味與法式手法，讓餐桌說故事。</span>
          </article>
          <article>
            <img
              src={IMG["funature-books"]}
              alt="馥自然書牆與選品空間實景，非沙龍活動紀錄"
              loading="lazy"
            />
            <p>11.15 / 20:00</p>
            <h3>黑膠音樂｜調飲沙龍</h3>
            <span>音樂、調飲與自由交流，慢慢延續夜晚。</span>
          </article>
        </div>
        <p className="mt-6 text-xs opacity-80">
          照片為既有場地、書封與料理素材；餐點內容以當日安排為準。
        </p>
      </div>
    </section>
  );
}

export function Itinerary() {
  return (
    <section id="itinerary" className="kt-section-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">THREE DAYS / 三日故事</p>
        <h2 className="kt-section-title">
          不只走過，
          <br />
          更是好好停留。
        </h2>
        <div className="kt-itinerary-list">
          <article className="kt-itinerary-day">
            <div>
              <p className="kt-eyebrow">DAY 01 / 11.14（六）</p>
              <h3>從山海入席，從故事相遇。</h3>
              <p className="kt-body-copy">
                抵達台東，讓藝術與餐桌開啟旅程。夜幕降下，聽范毅舜說起《公東的教堂》。
              </p>
            </div>
            <ol>
              <li>
                <time>11:10</time>
                <span>台東火車站接駁（建議台鐵408：台北07:20 → 台東11:10）</span>
              </li>
              <li>
                <time>11:30</time>
                <span>花里岸餐廳午餐｜費用自理</span>
              </li>
              <li>
                <time>14:00</time>
                <span>江賢二藝術園區</span>
              </li>
              <li>
                <time>16:00</time>
                <span>入住 INNTERVAL 馥自然人文空間</span>
              </li>
              <li>
                <time>16:30</time>
                <span>迎賓下午茶</span>
              </li>
              <li>
                <time>18:00</time>
                <span>莫子山海套餐</span>
              </li>
              <li>
                <time>20:00</time>
                <span>夜間沙龍｜公東的教堂</span>
              </li>
            </ol>
          </article>
          <article className="kt-itinerary-day">
            <div>
              <p className="kt-eyebrow">DAY 02 / 11.15（日）</p>
              <h3>走進教堂，也走近生命。</h3>
              <p className="kt-body-copy">
                清晨與自然相處，午後跟著范毅舜讀懂建築中的人文故事。夜晚，把對話留給音樂與彼此。
              </p>
            </div>
            <ol>
              <li>
                <time>06:00</time>
                <span>自由日出約會・晨間漫遊（自由參加）</span>
              </li>
              <li>
                <time>08:00</time>
                <span>馥自然早餐</span>
              </li>
              <li>
                <time>10:00</time>
                <span>馥自然園區生態探索（自由參加）</span>
              </li>
              <li>
                <time>11:30</time>
                <span>野菜蔬食午餐</span>
              </li>
              <li>
                <time>12:30</time>
                <span>出發前往公東教堂</span>
              </li>
              <li>
                <time>13:30</time>
                <span>抵達公東教堂</span>
              </li>
              <li>
                <time>14:30</time>
                <span>范毅舜親自導覽公東教堂｜結束時間待確認</span>
              </li>
              <li>
                <time>18:00</time>
                <span>莫子主廚創意料理</span>
              </li>
              <li>
                <time>20:00</time>
                <span>黑膠音樂調飲沙龍・自由交流</span>
              </li>
            </ol>
          </article>
          <article className="kt-itinerary-day">
            <div>
              <p className="kt-eyebrow">DAY 03 / 11.16（一）</p>
              <h3>帶著海岸的光，回到日常。</h3>
              <p className="kt-body-copy">
                沿海岸北行，在牧場與海景餐桌之間停留，讓三天的相遇慢慢沉澱。
              </p>
            </div>
            <ol>
              <li>
                <time>08:00</time>
                <span>馥自然早餐</span>
              </li>
              <li>
                <time>09:30</time>
                <span>退房・專車出發</span>
              </li>
              <li>
                <time>10:00</time>
                <span>笑笑羊牧場</span>
              </li>
              <li>
                <time>12:00</time>
                <span>里漾餐廳 Lyang・海景秘境小餐館午餐</span>
              </li>
              <li>
                <time>14:40</time>
                <span>專車前往玉里火車站</span>
              </li>
              <li>
                <time>16:13</time>
                <span>建議台鐵431自強號：玉里16:13 → 台北19:49</span>
              </li>
            </ol>
          </article>
        </div>
        <div className="kt-transport-note">
          <p className="kt-transport-title">台北-台東出發的朋友：</p>
          <p className="kt-body-copy">
            去程建議台鐵408、回程建議台鐵431，列車時刻僅供參考，請自行核對最新時刻與訂票。
          </p>
        </div>
        <p className="kt-itinerary-note">導覽結束時間待確認；講座主講與行程內容以實際確認為準。</p>
        <div className="mt-8">
          <a
            href="#register"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 kt-journey-button"
          >
            預約這趟文化旅程
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="lucide lucide-arrow-up-right"
              aria-hidden="true"
            >
              <path d="M7 7h10v10" />
              <path d="M7 17 17 7" />
            </svg>
          </a>
        </div>
      </div>
    </section>
  );
}

export function Space() {
  return (
    <section id="space" className="kt-section-band kt-space-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">STAY & TASTE / 空間與餐桌</p>
        <h2 className="kt-section-title mb-12">
          在馥自然，
          <br />
          感受生活的款待。
        </h2>
        <div className="kt-space-content">
          {"          "}
          <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
            <div className="space-y-6">
              <img
                src={IMG["funature-exterior"]}
                alt="馥自然人文空間的清水模建築外觀"
                loading="lazy"
                className="w-full object-cover"
              />
              <div className="grid grid-cols-2 gap-4">
                <img
                  src={IMG["funature-room"]}
                  alt="馥自然人文空間臨海客房"
                  loading="lazy"
                  className="aspect-[4/3] w-full object-cover"
                />
                <img
                  src={IMG["funature-books"]}
                  alt="馥自然館內的書牆與選品"
                  loading="lazy"
                  className="aspect-[4/3] w-full object-cover"
                />
              </div>
            </div>
            <div>
              <p className="text-sm text-primary">旅程的家</p>
              <h2 className="mt-4 text-3xl">INNTERVAL 馥自然人文空間</h2>
              <p className="mt-6 leading-loose text-muted-foreground">
                山海間的靜謐之所。隱於台東東河鄉的山海之間，鄰近江賢二藝術園區，
                以當地的自然與文化為靈感，把藝術、設計與生活緊緊織在一起。
                清水模與木質交織的空間，名字取自樂譜裡的「休止符」——
                在這裡走動、停頓、望海、閱讀，讓時間慢下來，與大地一起呼吸。
              </p>
              <p className="mt-4 leading-loose text-muted-foreground">
                客房以阿美族聖歌命名：塔米利是誕生與祝福，阿努安意為「一起唱歌」，
                亞維尤是「日出之地」的祝福歌——每個名字，都是一段迎向晨光的歌。
              </p>
              <p className="mt-4 leading-loose text-muted-foreground">
                館內的「馥選生活」，是一座藏在旅宿裡的選品店；清晨則有以當地時令食材
                入饌的款待，手工烘焙的麵包與慢火熬煮的湯品，用土地的溫度喚醒一天。
              </p>
            </div>
          </div>
          <div className="grid items-center gap-10 md:grid-cols-[minmax(0,260px)_1fr] md:gap-16">
            <img
              src={IMG["funature-chef"]}
              alt="山海料理人莫子"
              loading="lazy"
              className="mx-auto w-full max-w-[260px] object-cover"
            />
            <div>
              <p className="text-sm text-primary">主廚介紹 Chef</p>
              <h2 className="mt-4 text-3xl">山海料理人｜莫子</h2>
              <p className="mt-6 leading-loose text-muted-foreground">
                莫子是來自台東達谷梵部落的阿美族料理人。2016 至 2020
                年，莫子在法國安古蘭（Angoulême） 跟隨法國主廚 Reine Soumagnac 工作擔任二廚；2018
                年創立「莫子醬物所」， 以在地食材結合法式手法，說出不一樣的土地故事。
              </p>
              <ul className="mt-8 space-y-4 border-l border-primary/30 pl-5">
                <li>
                  <span className="text-xs text-primary">2018</span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    創立「莫子醬物所」餐廳外燴團隊，擔任負責人與主廚；同年餐廳獲法國在台協會認證，為全台
                    17 家之一。
                  </p>
                </li>
                <li>
                  <span className="text-xs text-primary">2019</span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    獲選法國「味覺法國」活動餐廳。
                  </p>
                </li>
                <li>
                  <span className="text-xs text-primary">2023</span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    獲選江振誠「500 盤」餐廳，擔任主廚。
                  </p>
                </li>
                <li>
                  <span className="text-xs text-primary">2024</span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    擔任文化部港口部落「海社會」計畫主廚，並獲台灣生態飲食設計中心邀請，
                    成為「彰化西海岸永續」生態廚師；同年為全聯系列廣告擔任食物設計。
                  </p>
                </li>
                <li>
                  <span className="text-xs text-primary">2025</span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    以遊艇外燴與私廚為主要業務，持續探索山海之間的風味。
                  </p>
                </li>
              </ul>
              <p className="mt-6 leading-loose text-muted-foreground">
                擅長風味的堆疊、盤飾變化與人文訴說，一點一滴注入每一道料理。
                第一晚的馥自然山海套餐，便出自莫子之手。
              </p>
              <img
                src={IMG["funature-dish"]}
                alt="莫子主廚的山海料理"
                loading="lazy"
                className="mt-8 w-full object-cover"
              />
            </div>
          </div>
        </div>
        <figure className="kt-gift-layout">
          <img src={IMG["funature-slippers"]} alt="INDOSOLE 環保拖鞋贈禮實拍" loading="lazy" />
          <figcaption>
            <p className="kt-eyebrow">A GIFT FOR EVERYDAY / 帶回日常的贈禮</p>
            <h3 className="text-2xl mt-4">INDOSOLE｜環保拖鞋</h3>
            <p className="kt-body-copy">
              以回收廢棄輪胎製作鞋底的品牌。響應環保，為旅客準備品牌拖鞋（價值
              NT$1,680），陪你走過旅程，也回到日常。
            </p>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export function Price() {
  return (
    <section id="price" className="kt-section-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">FEE & ASSURANCE / 旅程費用說明</p>
        <h2 className="kt-section-title">
          讓美好的旅行，
          <br />
          從安心出發。
        </h2>
        <div className="kt-fee-intro">
          <p className="kt-body-copy">
            希望每一位同行的旅人，都能帶著輕鬆愉快的心情，享受這趟充滿文化、藝術與生活美學的台東之旅。
          </p>
          <p className="kt-body-copy">
            我們用心安排了旅途中的住宿、餐飲、接駁與文化體驗，也將費用內容清楚列出，讓您在出發前就能安心準備。
          </p>
        </div>
        <div className="kt-fee-cards">
          <div className="kt-fee-card">
            <p className="kt-fee-card-label">旅程費用</p>
            <p className="kt-price-number">
              NT$19,800
              <span>／人</span>
            </p>
            <p className="kt-fee-card-meta">三天兩夜｜兩人一房｜6 人（含）以上成行</p>
            <p className="kt-fee-card-meta">
              含住宿兩晚、火車站與行程接駁、入園門票、教堂導覽、六餐、兩晚沙龍與無酒精飲料吧。
            </p>
          </div>
          <div className="kt-fee-card kt-fee-card-member">
            <p className="kt-fee-card-label">小時光知友獨享價</p>
            <p className="kt-price-number">
              NT$16,800
              <span>／人</span>
            </p>
            <p className="kt-fee-card-meta">
              感謝一路相伴的小時光知友，我們特別準備了每人 NT$3,000
              的專屬優惠，邀請您與我們一起走進台東的山海與人文風景。如您為小時光知友，歡迎於報名備註註明，或直接與我們確認適用方式。
            </p>
          </div>
        </div>
        <div className="kt-fee-single">
          <p className="kt-fee-card-label">單人入住</p>
          <p className="kt-body-copy">
            若希望享有獨立的住宿空間，亦可選擇單人入住，兩晚加價 NT$10,000。
          </p>
          <ul>
            <li>
              <span>一般旅程價格，單人入住總費用</span>
              <strong>NT$29,800／人</strong>
            </li>
            <li>
              <span>小時光知友獨享價，單人入住總費用</span>
              <strong>NT$26,800／人</strong>
            </li>
          </ul>
        </div>
        <div className="kt-price-columns">
          <div>
            <p className="kt-eyebrow">01</p>
            <h3>
              <span className="kt-fee-mark" aria-hidden="true">
                ✓
              </span>
              旅程費用已包含
            </h3>
            <p className="kt-fee-columns-note">
              為了讓您在出發前就能安心準備，以下項目已包含在團費內：
            </p>
            <ul>
              <li>
                <strong>舒適住宿</strong>
                <span>馥自然兩晚住宿（兩人一房）</span>
              </li>
              <li>
                <strong>貼心接駁</strong>
                <span>台東火車站往返及行程安排的接駁服務</span>
              </li>
              <li>
                <strong>藝術巡禮</strong>
                <span>江賢二藝術園區入園門票</span>
              </li>
              <li>
                <strong>文化深度體驗</strong>
                <span>范毅舜老師親自導覽公東教堂</span>
              </li>
              <li>
                <strong>精心安排的活動</strong>
                <span>行程表所列館內體驗活動</span>
              </li>
              <li>
                <strong>沙龍交流</strong>
                <span>夜間沙龍與黑膠音樂調飲沙龍</span>
              </li>
              <li>
                <strong>美好餐食</strong>
                <span>兩天早餐、第二天與第三天午餐，以及兩晚晚餐，共六餐</span>
              </li>
              <li>
                <strong>自在時光</strong>
                <span>無酒精飲料吧</span>
              </li>
            </ul>
          </div>
          <div>
            <p className="kt-eyebrow">02</p>
            <h3>
              <span className="kt-fee-mark" aria-hidden="true">
                ♡
              </span>
              以下費用敬請自行安排
            </h3>
            <p className="kt-fee-columns-note">
              為了讓旅程保有一些自在選擇的空間，以下項目未包含在團費內：
            </p>
            <ul>
              <li>
                <strong>往返台東的交通費</strong>
                <span>
                  無論選擇搭乘火車、飛機或自行開車，都可以依照自己最舒適的方式安排，相關費用敬請自理。
                </span>
              </li>
              <li>
                <strong>第一天午餐</strong>
                <span>我們安排在花里岸餐廳，您可以依照喜好自由點餐，餐費由旅人自行結帳。</span>
              </li>
              <li>
                <strong>單人入住差額</strong>
                <span>如希望一人獨享房間，兩晚需另加 NT$10,000。</span>
              </li>
              <li>
                <strong>個人消費</strong>
                <span>旅途中自行購買的紀念品、額外餐飲及其他私人消費。</span>
              </li>
            </ul>
          </div>
        </div>
        <div className="kt-fee-payment">
          <p className="kt-fee-card-label">付款方式</p>
          <p className="kt-body-copy">
            送出報名資料不代表付款完成。結帳時可選擇以下三種付款方式；選擇銀行匯款時，匯款資訊會在結帳完成後提供（顯示在訂單完成頁，並同時寄到你的電子信箱），請於下單後
            3
            天內完成匯款，並在訂單頁回報匯款帳號末五碼，我們核對款項後會以電子郵件通知你。逾期未匯款，訂單會自動取消、名額釋出。
          </p>
          <ul>
            <li>
              <span>信用卡</span>
              <strong>線上刷卡付款</strong>
            </li>
            <li>
              <span>銀行匯款</span>
              <strong>結帳完成後提供匯款資訊</strong>
            </li>
            <li>
              <span>需要協助</span>
              <strong>選匯款時可勾選專人聯繫</strong>
            </li>
          </ul>
        </div>
        <div className="kt-fee-notes">
          <h3>關於住宿與集合的小提醒</h3>
          <p className="kt-body-copy">
            本次旅程以兩人入住一房為安排基準。如果您是一個人報名，也歡迎先與我們聯繫，討論合適的住宿方式；如需單人獨住，則依上述標準加收房費差額。
          </p>
          <p className="kt-body-copy">
            旅程將從台東火車站展開，請依照行前通知的集合時間抵達，我們會安排接駁，迎接大家一起出發。
          </p>
          <p className="kt-fee-closing">
            期待與您在台東相見。讓我們把繁忙暫時留在城市裡，留三天給山海、藝術、故事，也留一點溫柔的時間給自己。
          </p>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section id="faq" className="kt-faq-band kt-section-band">
      <div className="kt-editorial-container kt-faq-layout">
        <div>
          <p className="kt-eyebrow">BEFORE YOU GO / 常見問題</p>
          <h2 className="kt-section-title">
            出發之前，
            <br />
            你可能想知道。
          </h2>
        </div>
        <div>
          <details>
            <summary>
              旅程費用如何計算？何時付款？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>
              旅程費用每人 NT$19,800，小時光知友獨享價每人 NT$16,800，皆為兩人一房；單人入住兩晚加價
              NT$10,000（一般 NT$29,800、知友
              NT$26,800）。結帳時可選擇信用卡線上付款或銀行匯款；選擇銀行匯款時，如需專人協助付款，可勾選「我需要專人聯繫協助付款」。送出報名資料不代表付款完成；選擇銀行匯款時，匯款資訊會在結帳完成後提供，請於下單後
              3 天內完成匯款，逾期名額將釋出。
            </p>
          </details>
          <details>
            <summary>
              幾位旅客可以成行？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>六人（含）以上成行。</p>
          </details>
          <details>
            <summary>
              交通怎麼安排？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>
              包含台東火車站往返及行程安排的接駁服務。往返台東的火車、飛機或自行開車費用敬請自理；去程建議台鐵408、回程建議台鐵431，列車時刻僅供參考，請自行核對最新時刻與訂票。
            </p>
          </details>
          <details>
            <summary>
              餐食包含哪些？有飲食需求怎麼辦？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>
              已包含兩天早餐、第二天與第三天午餐，以及兩晚晚餐，共六餐，另有無酒精飲料吧。首日午餐安排在花里岸餐廳，餐費自行結帳。素食或過敏需求請填在表單，由主辦確認安排。
            </p>
          </details>
          <details>
            <summary>
              雙人房如何安排？可以單人入住嗎？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>
              本次以兩人入住一房為安排基準。如果您是一個人報名，歡迎先與我們聯繫討論合適的住宿方式；如需單人獨住，兩晚另加
              NT$10,000。
            </p>
          </details>
          <details>
            <summary>
              如果需要取消參加，該怎麼辦？
              <span aria-hidden="true">＋</span>
            </summary>
            <p>我們珍惜每一份相聚的期待，也理解生活有時需要臨時調整。</p>
            <p>
              若您有特殊情況需要取消，請直接聯繫小時光團隊（intervalbookstores@gmail.com），我們將依個別契約內容及適用法規協助處理，保障您的權益。
            </p>
            <p>謝謝您的理解與信任。</p>
          </details>
        </div>
      </div>
    </section>
  );
}

export function TripNotice() {
  return (
    <div className="kt-trip-notice kt-editorial-container">
      <p>
        主辦單位保有最終修改、變更、活動解釋及取消本活動之權利。行程車次、導覽與講座時間僅為預估，主辦單位得依當日實際現場狀況、天候或不可抗力因素調整活動內容，相關最新通知將以主辦單位官方公告或個別行前通知為準。
      </p>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="kt-site-footer kt-editorial-container">
      <div>
        <p className="font-serif text-lg">范毅舜公東教堂文化之旅</p>
        <p className="mt-2 text-xs">INNTERVAL 馥自然人文空間・2026.11.14–11.16</p>
      </div>
      <div className="kt-site-footer-contact">
        <a href="tel:0223416800">02-2341-6800</a>
        <a href="tel:0917540615">0917-540-615</a>
        <a href="mailto:intervalbookstores@gmail.com">intervalbookstores@gmail.com</a>
      </div>
      <nav className="kt-site-footer-social" aria-label="小時光網站與社群連結">
        <p className="kt-site-footer-label">追蹤小時光</p>
        <a href="https://www.intervalbooks.tw/" target="_blank" rel="noopener noreferrer">
          小時光網站
        </a>
        <a href="https://linktr.ee/intervalbookstw" target="_blank" rel="noopener noreferrer">
          小時光 Linktree
        </a>
        <a
          href="https://www.facebook.com/intervalbookstw/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Facebook
        </a>
        <a
          href="https://www.instagram.com/intervalbookstw/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Instagram
        </a>
        <a
          href="https://www.threads.com/@intervalbookstw?hl=zh-tw"
          target="_blank"
          rel="noopener noreferrer"
        >
          Threads
        </a>
      </nav>
    </footer>
  );
}
