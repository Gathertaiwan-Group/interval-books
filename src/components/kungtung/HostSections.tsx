/**
 * 原站的兩個主理人內頁（/hosts/fan-yishun、/hosts/alice）的章節，轉換方式同 MainSections.tsx。
 */
import { IMG } from "./images";

export function FanNav() {
  return (
    <nav className="kt-editorial-container kt-host-page-nav" aria-label="人物專頁導覽">
      <a className="kt-host-back" href="/events/kungtung#hosts">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-arrow-left"
          aria-hidden="true"
        >
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
        回到旅程首頁
      </a>
      <a className="kt-host-back" href="/events/kungtung#register">
        預約這趟文化旅程
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
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
  );
}

export function FanHeader() {
  return (
    <header className="kt-editorial-container kt-host-page-hero">
      <img
        src={IMG["fan-yishun-portrait"]}
        width="1409"
        height="1920"
        alt="攝影作家范毅舜的真實肖像"
        className="kt-host-page-portrait"
      />
      <div>
        <p className="kt-host-eyebrow">
          <span className="kt-host-eyebrow-en">THE GUIDE</span>
          <span className="kt-host-eyebrow-zh">這趟旅程的領路人</span>
        </p>
        <h1 className="kt-host-page-name">
          范毅舜
          <span className="kt-host-role">｜文化領路人</span>
        </h1>
        <p className="kt-host-introduction">帶領旅人走進建築背後的文化與生命故事。</p>
        <p className="kt-body-copy">
          攝影作家，大家都叫他「小五哥」。他用影像和文字，記錄建築、信仰與人的故事。他常說：「光是攝影的靈魂。」從歐洲的修道院、大教堂，到台東的公東教堂，他一直在光影裡找尋人與土地的連結。
        </p>
      </div>
    </header>
  );
}

export function FanSection1() {
  return (
    <section className="kt-editorial-container kt-host-page-section">
      <h2 className="kt-host-page-heading">經歷</h2>
      <ul className="kt-host-career">
        <li>中國文化大學美術系畢業，在台南教書時開始接觸攝影。</li>
        <li>美國加州布魯克斯攝影學院（Brooks Institute of Photography）碩士。</li>
        <li>
          以「老家人」系列成為誠品藝廊首位舉辦展覽的攝影師；1994
          年於美國華府參議院展出，《華盛頓郵報》曾以半版報導。
        </li>
        <li>
          曾於德國 Leica
          藝廊、法國尼斯、台北誠品藝廊等地舉辦攝影個展；作品為美國國會圖書館、台北市立美術館等單位收藏。
        </li>
        <li>
          瑞典哈蘇（Hasselblad）曾推崇為全球 150 位優秀攝影家之一，亦曾擔任 SWPA 國際攝影大賽評審。
        </li>
        <li>
          曾在法國拉圖雷特修道院駐院拍攝；回台後從台東白冷會神父的故事出發，開啟記錄台灣土地的創作路線。
        </li>
      </ul>
    </section>
  );
}

export function FanSection2() {
  return (
    <section className="kt-editorial-container kt-host-page-section">
      <h2 className="kt-host-page-heading">代表著作</h2>
      <div className="kt-host-books">
        <article>
          <img src={IMG["gongdong_chapel_cover_stone"]} alt="《公東的教堂》書封" loading="lazy" />
          <h3>《公東的教堂》</h3>
          <p>
            記錄 1958
            年建造、有「台灣廊香教堂」之稱的公東高工教堂，以及白冷會士的教育故事。這趟旅程的起點。
          </p>
        </article>
        <article>
          <img
            src={IMG["coastal_range_swiss_cover_3d"]}
            alt="《海岸山脈的瑞士人》書封"
            loading="lazy"
          />
          <h3>《海岸山脈的瑞士人》</h3>
          <p>瑞士白冷會神父在台東落地生根的生命故事，也是他記錄台灣土地的開端。</p>
        </article>
        <article>
          <img
            src={IMG["convent_on_the_hill_cover_wall"]}
            alt="《山丘上的修道院》書封"
            loading="lazy"
          />
          <h3>《山丘上的修道院》</h3>
          <p>駐院拉圖雷特修道院期間，拍下建築的細緻光影與修士的日常。</p>
        </article>
        <article>
          <img src={IMG["walk_into_cathedral_cover"]} alt="《走進一座大教堂》書封" loading="lazy" />
          <h3>《走進一座大教堂》</h3>
          <p>帶讀者讀懂一座歐洲大教堂的建築與信仰。</p>
        </article>
      </div>
      <p className="mt-8 text-sm leading-loose text-muted-foreground">
        其他著作：《老家人》、《臺南‧家》、《野台戲》、《歐陸教堂巡禮》、《普羅旺斯的聖誕夜》、《攝影行遊間》等，累計出版近五十本攝影與文學作品。
      </p>
    </section>
  );
}

export function FanSection3() {
  return (
    <section className="kt-editorial-container kt-host-page-section">
      <h2 className="kt-host-page-heading">媒體報導與講座</h2>
      <ul className="kt-host-media-list">
        <li>
          <a
            href="https://seeds.com.tw/en/blog/nicholas-fan"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">學籽・2024</span>
            <span className="kt-host-media-title">
              「攝影，是你端詳這個世界的方式。」專訪國際人文紀實藝術家范毅舜
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://www.gfc.org.tw/project-news/3955"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">大唐人文講座・2020</span>
            <span className="kt-host-media-title">
              從歐洲文化遺產到公東的教堂及野台戲──我的攝影之路
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://opinion.cw.com.tw/blog/profile/195/article/5882"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">獨立評論＠天下・2017</span>
            <span className="kt-host-media-title">公東傳奇──海岸山脈的大愛</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://www.lac.org.tw/eventbulletin/20130509-5584-1502068385"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">大愛二台｜中華民國圖書館學會・2013</span>
            <span className="kt-host-media-title">愛悅讀－文學歷史《公東的教堂》范毅舜</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://newmsgr.pct.org.tw/Magazine.aspx?strISID=136&strMAGID=M2013062103327&strTID=1"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">新使者雜誌 136 期</span>
            <span className="kt-host-media-title">從《公東的教堂》探索教堂美學與信仰</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://news.readmoo.com/2013/06/06/chapelofkungtung/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">Readmoo 閱讀最前線・2013</span>
            <span className="kt-host-media-title">
              【果子離群索書】公東的教堂，時代的記憶與感情
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a href="http://www.cap.org.tw/W/w-182-7.html" target="_blank" rel="noopener noreferrer">
            <span className="kt-host-media-source">曠野雜誌・2013</span>
            <span className="kt-host-media-title">【曠野 182 期】《公東的教堂》書評</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://archive.ncafroc.org.tw/result?id=e7dd68f8d4f0418d9cdf9726ea86646b"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">國藝會補助成果檔案庫</span>
            <span className="kt-host-media-title">公東的教堂—《海岸山脈的瑞士人》第二部</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://news.pchome.com.tw/magazine/report/li/digiphoto/5019/130979520080889088007.htm"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">DIGIPHOTO（PChome 新聞）・2011</span>
            <span className="kt-host-media-title">在 逐光獵影之外－范毅舜專訪</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://bookzone.cwgv.com.tw/author/9687"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">天下文化</span>
            <span className="kt-host-media-title">作者介紹：范毅舜</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        連結皆前往外部網站，內容以原刊登單位為準。
      </p>
    </section>
  );
}

export function FanSection4() {
  return (
    <section className="kt-editorial-container kt-host-page-cta">
      <p className="kt-eyebrow">2026.11.14–11.16｜台東・三天兩夜</p>
      <h2 className="kt-section-title">有些故事，值得親自走進去。</h2>
      <a className="kt-journey-button kt-host-cta-link" href="/events/kungtung#register">
        預約這趟文化旅程
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
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
    </section>
  );
}
export function AliceNav() {
  return (
    <nav className="kt-editorial-container kt-host-page-nav" aria-label="人物專頁導覽">
      <a className="kt-host-back" href="/events/kungtung#hosts">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-arrow-left"
          aria-hidden="true"
        >
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
        回到旅程首頁
      </a>
      <a className="kt-host-back" href="/events/kungtung#register">
        預約這趟文化旅程
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
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
  );
}

export function AliceHeader() {
  return (
    <header className="kt-editorial-container kt-host-page-hero">
      <img
        src={IMG["alice-portrait-tea"]}
        width="1420"
        height="1542"
        alt="Alice 劉柳樺於文化茶席間，微笑手捧茶杯"
        className="kt-host-page-portrait kt-host-page-portrait--alice"
      />
      <div>
        <p className="kt-host-eyebrow">
          <span className="kt-host-eyebrow-en">THE HOST</span>
          <span className="kt-host-eyebrow-zh">這趟旅程的款待者</span>
        </p>
        <h1 className="kt-host-page-name">
          Alice 劉柳樺
          <span className="kt-host-role">｜文化策旅人</span>
        </h1>
        <p className="kt-host-signature">小時光風土誌書店主理人 × 馥自然人文空間策旅主理人</p>
        <p className="kt-host-introduction">把文化帶進生活，把相遇變成值得珍藏的記憶。</p>
        <p className="kt-body-copy">
          從台北華山的小時光風土誌書店，到台東山海間的馥自然，Alice
          始終相信，文化不只存在於書本與展覽之中，也存在於一席餐桌、建築、音樂，以及人與人真誠相遇的時刻。
        </p>
      </div>
    </header>
  );
}

export function AliceSection1() {
  return (
    <section className="kt-editorial-container kt-host-page-section">
      <h2 className="kt-host-page-heading">經歷</h2>
      <div className="kt-host-roles">
        <article>
          <h3>小時光風土誌書店｜主理人・策展人</h3>
          <p>
            位於台北華山 1914
            文化創意產業園區。從一櫃書、一張長桌開始，慢慢有了陶藝家的器物、地方夥伴的選物，以及每月一場的讀書會。
          </p>
        </article>
        <article>
          <h3>馥自然人文空間｜策旅主理人</h3>
          <p>在台東山海之間，把文化、空間、餐桌、音樂與人際交流，策劃成一段值得珍藏的生活體驗。</p>
        </article>
      </div>
    </section>
  );
}

export function AliceSection2() {
  return (
    <section className="kt-editorial-container kt-host-page-section kt-host-page-split">
      <div>
        <h2 className="kt-host-page-heading">策展與策旅</h2>
        <ul className="kt-host-career">
          <li>風土誌策展：以地方為線索，策劃書展、選物與內容。</li>
          <li>活動與讀書會：讀書會、講座與工作坊。</li>
          <li>策旅與合作共創：與在地夥伴設計風土主題旅程，並與品牌共同創作。</li>
        </ul>
        <p className="kt-body-copy mt-8">
          這一次，她邀請攝影作家范毅舜，以公東教堂的建築與生命故事為起點，親自策劃三天兩夜的山海文化之旅。不只是帶大家去看一座教堂，更希望每位旅人，都能帶著新的感動回到生活。
        </p>
      </div>
      <img
        src={IMG["funature-exterior"]}
        alt="馥自然人文空間建築外觀實景"
        loading="lazy"
        className="kt-host-page-place"
      />
    </section>
  );
}

export function AliceSection3() {
  return (
    <section className="kt-editorial-container kt-host-page-section">
      <h2 className="kt-host-page-heading">媒體報導與相關連結</h2>
      <ul className="kt-host-media-list">
        <li>
          <a href="https://www.intervalbooks.tw/about" target="_blank" rel="noopener noreferrer">
            <span className="kt-host-media-source">小時光書店 Interval Books</span>
            <span className="kt-host-media-title">關於小時光</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
        <li>
          <a
            href="https://www.huashan1914.com/store/%E5%B0%8F%E6%99%82%E5%85%89%E6%9B%B8%E5%BA%97"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="kt-host-media-source">華山 1914 文化創意產業園區</span>
            <span className="kt-host-media-title">小時光書店</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
        </li>
      </ul>
    </section>
  );
}

export function AliceSection4() {
  return (
    <section className="kt-editorial-container kt-host-page-cta">
      <p className="kt-eyebrow">2026.11.14–11.16｜台東・三天兩夜</p>
      <h2 className="kt-section-title">有些故事，值得親自走進去。</h2>
      <a className="kt-journey-button kt-host-cta-link" href="/events/kungtung#register">
        預約這趟文化旅程
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
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
    </section>
  );
}
