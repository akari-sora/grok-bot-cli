import { Video } from "@remotion/media";
import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Series,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// 1080 x 1920, phone first: key text >= 80px from the sides, >= 100px from top and bottom.
const SIDE = 80;
const FONT = '-apple-system, "SF Pro Display", "PingFang TC", "Helvetica Neue", sans-serif';
const MONO = '"SF Mono", Menlo, "PingFang TC", monospace';
const VIOLET = "#a78bfa";

const fadeUp = (frame: number, fps: number, delay = 0) => ({
  opacity: interpolate(frame, [delay, delay + 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  }),
  translate: interpolate(frame, [delay, delay + 0.5 * fps], ["0px 40px", "0px 0px"], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  }),
});

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: "radial-gradient(120% 70% at 50% 0%, #2a1a52 0%, #120c24 55%, #08070d 100%)",
      fontFamily: FONT,
      color: "white",
    }}
  >
    {children}
  </AbsoluteFill>
);

// Step label, headline (EN) and one supporting line (zh-TW), at the top of the frame.
const Caption: React.FC<{ step?: string; title: string; zh: string }> = ({ step, title, zh }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 130, left: SIDE, right: SIDE, ...fadeUp(frame, fps) }}>
      {step ? <div style={{ fontSize: 38, color: VIOLET, fontWeight: 700, letterSpacing: 2 }}>{step}</div> : null}
      <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.05, marginTop: 12 }}>{title}</div>
      <div style={{ fontSize: 44, color: "#d4cfe6", marginTop: 20, lineHeight: 1.3 }}>{zh}</div>
    </div>
  );
};

// A terminal recording in a window frame below the caption.
const Terminal: React.FC<{ src: string; top?: number; trimBefore?: number }> = ({ src, top = 620, trimBefore = 0 }) => (
  <div
    style={{
      position: "absolute",
      top,
      left: 40,
      right: 40,
      borderRadius: 28,
      overflow: "hidden",
      background: "#0d0d12",
      boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
      border: "2px solid #2b2540",
    }}
  >
    <div style={{ height: 56, display: "flex", alignItems: "center", gap: 14, paddingLeft: 26, background: "#17151f" }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <div key={c} style={{ width: 20, height: 20, borderRadius: 10, background: c }} />
      ))}
    </div>
    <Video src={staticFile(src)} trimBefore={trimBefore} muted style={{ width: "100%", display: "block" }} />
  </div>
);

const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <div style={{ position: "absolute", top: 440, left: SIDE, right: SIDE, ...fadeUp(frame, fps) }}>
        <div style={{ fontSize: 46, color: VIOLET, fontWeight: 700 }}>gbot migrate</div>
        <div style={{ fontSize: 120, fontWeight: 850, lineHeight: 1.04, marginTop: 20 }}>Move your<br />Grok Bot.</div>
        <div style={{ fontSize: 120, fontWeight: 850, lineHeight: 1.04, color: VIOLET }}>Keep working.</div>
      </div>
      <div style={{ position: "absolute", top: 1070, left: SIDE, right: SIDE, ...fadeUp(frame, fps, 0.4 * fps) }}>
        <div style={{ fontSize: 52, color: "#e9e4ff" }}>to Hermes · Muse · Your dot</div>
        <div style={{ fontSize: 46, color: "#bfb6dc", marginTop: 26, lineHeight: 1.4 }}>
          把 Grok Bot 的角色、記憶、Skills、排程、任務和完整對話搬過去，搬完直接接著做事。
        </div>
      </div>
    </Backdrop>
  );
};

const Bubble: React.FC<{ who: string; color: string; text: string; delay: number }> = ({ who, color, text, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ marginTop: 34, ...fadeUp(frame, fps, delay) }}>
      <div style={{ fontSize: 36, fontWeight: 700, color }}>{who}</div>
      <div
        style={{
          marginTop: 12,
          background: "#1c1830",
          border: `2px solid ${color}55`,
          borderRadius: 30,
          padding: "28px 34px",
          fontSize: 38,
          lineHeight: 1.42,
          color: "#efeaff",
        }}
      >
        {text}
      </div>
    </div>
  );
};

const ContinuesElsewhere: React.FC = () => (
  <Backdrop>
    <Caption step="4 · MUSE & YOUR DOT" title="They pick up the work too" zh="沒有給任何提示，只憑搬過去的資料接著做（Muse 用全新的聊天室）。" />
    <div style={{ position: "absolute", top: 610, left: SIDE, right: SIDE }}>
      <div style={{ fontSize: 36, color: "#a59cc4" }}>“Dates confirmed — do the next item on your to-do list. Don’t book anything.”</div>
      <Bubble
        who="Muse"
        color="#60a5fa"
        delay={20}
        text="Recommended: Urbain Kyoto Kiyomizu Gojo — 8.8/10, USD 85 for two nights, fully refundable. Check-in Sat Dec 12, check-out Mon Dec 14. Within your TWD 8,000 hotel cap."
      />
      <Bubble
        who="Your dot"
        color="#34d399"
        delay={60}
        text="我推薦 Urbain Kyoto Kiyomizu Gojo。12 月 12 日入住、14 日退房，共 2 晚；整趟預算 NT$30,000，住宿先抓 NT$8,000 內。訂房信也問了素食早餐。"
      />
    </div>
  </Backdrop>
);

const Template: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <Caption step="5 · NO TERMINAL" title="Add the Move to Hermes bot" zh="不想開終端機：把公開範本加進你的 Grok Bot，它會逐步帶你搬。" />
      <div
        style={{
          position: "absolute",
          top: 600,
          left: 250,
          width: 580,
          borderRadius: 56,
          overflow: "hidden",
          border: "10px solid #24203a",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          ...fadeUp(frame, fps, 10),
        }}
      >
        <Img src={staticFile("template-card.png")} style={{ width: "100%", display: "block" }} />
      </div>
      <div style={{ position: "absolute", bottom: 130, left: SIDE, right: SIDE, textAlign: "center", fontSize: 40, color: "#e9e4ff", fontFamily: MONO }}>
        x.ai/bot/y2AFnYLdbz5T66loRBHar
      </div>
    </Backdrop>
  );
};

const Agents: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = [
    ["$ gbot-install install claude", "#9ca3af"],
    ["› Move my Grok Bot to Hermes.", "#e9e4ff"],
    ["  gbot --json migrate bots", VIOLET],
    ["  gbot --json migrate preview … --to hermes", VIOLET],
    ["  (shows you the preview, waits for yes)", "#9ca3af"],
    ["  gbot --json migrate import … --yes", VIOLET],
    ["  ✓ read back 7/7 · ✓ questions answered", "#34d399"],
  ];
  return (
    <Backdrop>
      <Caption step="6 · FOR AGENTS" title="Claude Code can do it for you" zh="安裝外掛後，migrate-grok-bot skill 教 agent 怎麼安全地搬：先預覽、等你同意、再匯入驗收。" />
      <div
        style={{
          position: "absolute",
          top: 720,
          left: 40,
          right: 40,
          background: "#0d0d12",
          borderRadius: 28,
          border: "2px solid #2b2540",
          padding: "40px 36px",
          fontFamily: MONO,
          fontSize: 36,
          lineHeight: 1.75,
        }}
      >
        {lines.map(([text, color], i) => (
          <div key={i} style={{ color, ...fadeUp(frame, fps, 10 + i * 12) }}>
            {text}
          </div>
        ))}
      </div>
    </Backdrop>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <div style={{ position: "absolute", top: 600, left: SIDE, right: SIDE, ...fadeUp(frame, fps) }}>
        <div style={{ fontSize: 96, fontWeight: 850, lineHeight: 1.05 }}>grok-bot-cli</div>
        <div style={{ fontSize: 48, color: VIOLET, marginTop: 24 }}>gitlab.com/aa22396584/grok-bot-cli</div>
        <div style={{ fontSize: 42, color: "#d4cfe6", marginTop: 60, lineHeight: 1.45 }}>
          Install the package file from the GitLab release (not npm). Open source, MIT. Unofficial; not affiliated with xAI.
        </div>
        <div style={{ fontSize: 42, color: "#bfb6dc", marginTop: 30, lineHeight: 1.45 }}>從 GitLab release 下載套件檔安裝。開源、MIT 授權。</div>
      </div>
    </Backdrop>
  );
};

export const Promo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#08070d" }}>
      <Series>
        <Series.Sequence name="Title" durationInFrames={Math.round(3.5 * fps)}>
          <Title />
        </Series.Sequence>
        <Series.Sequence name="Pick and preview" durationInFrames={Math.round(14.4 * fps)}>
          <Backdrop>
            <Caption step="1 · CHOOSE" title="Pick the bot and where it goes" zh="選登入、選 bot、選目的地，先看會搬哪些、哪些搬不了。排程預設不動 Grok Bot。" />
            <Terminal src="phone-hermes.mp4" />
          </Backdrop>
        </Series.Sequence>
        <Series.Sequence name="Import and check" durationInFrames={Math.round(5.8 * fps)}>
          <Backdrop>
            <Caption step="2 · MOVE & CHECK" title="Imported, read back, checked" zh="匯入後從 Hermes 讀回每一項，再問只有搬過去的資料才答得出的問題。" />
            <Terminal src="phone-hermes.mp4" trimBefore={Math.round(15.45 * fps)} />
          </Backdrop>
        </Series.Sequence>
        <Series.Sequence name="Hermes continues" durationInFrames={Math.round(15 * fps)}>
          <Backdrop>
            <Caption step="3 · KEEP WORKING" title="It picks up where it left off" zh="日期確認了，請它接著做下一步：它從搬過去的資料寫出飯店、日期、預算和素食需求。" />
            <Terminal src="phone-hermes.mp4" trimBefore={Math.round(21.25 * fps)} />
          </Backdrop>
        </Series.Sequence>
        <Series.Sequence name="Muse and dot continue" durationInFrames={10 * fps}>
          <ContinuesElsewhere />
        </Series.Sequence>
        <Series.Sequence name="Move to Hermes template" durationInFrames={6 * fps}>
          <Template />
        </Series.Sequence>
        <Series.Sequence name="For agents" durationInFrames={7 * fps}>
          <Agents />
        </Series.Sequence>
        <Series.Sequence name="Outro" durationInFrames={Math.round(4.5 * fps)}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
