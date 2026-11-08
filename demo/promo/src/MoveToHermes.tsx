import React from "react";
import { AbsoluteFill, Easing, Series, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { RESULT_LINES } from "./moveToHermesResult";

// A real Move to Hermes conversation (2026-11-09, Grok Bot account of the author), laid out for a
// phone. Every bubble quotes the bot or the user; the check list in scene 2 condenses four
// question-and-answer rounds into their real results.

const SIDE = 80;
const FONT = '-apple-system, "SF Pro Display", "PingFang TC", "Helvetica Neue", sans-serif';
const MONO = '"SF Mono", Menlo, "PingFang TC", monospace';
const VIOLET = "#a78bfa";
const BOT_BG = "#1c1830";
const USER_BG = "#5b3fd6";

const appear = (frame: number, fps: number, delay = 0) => ({
  opacity: interpolate(frame, [delay, delay + 0.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  }),
  translate: interpolate(frame, [delay, delay + 0.4 * fps], ["0px 36px", "0px 0px"], {
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

const Caption: React.FC<{ step: string; title: string; zh: string }> = ({ step, title, zh }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 110, left: SIDE, right: SIDE, ...appear(frame, fps) }}>
      <div style={{ fontSize: 36, color: VIOLET, fontWeight: 700, letterSpacing: 2 }}>{step}</div>
      <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, marginTop: 10 }}>{title}</div>
      <div style={{ fontSize: 42, color: "#d4cfe6", marginTop: 16, lineHeight: 1.3 }}>{zh}</div>
    </div>
  );
};

// The chat window: a header with the bot's name, then its children (bubbles) from the top.
const Chat: React.FC<{ children: React.ReactNode; top?: number }> = ({ children, top = 560 }) => (
  <div
    style={{
      position: "absolute",
      top,
      left: 36,
      right: 36,
      bottom: 90,
      borderRadius: 40,
      background: "#0e0c16",
      border: "2px solid #2b2540",
      boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
      overflow: "hidden",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "26px 34px", background: "#17151f" }}>
      <div style={{ width: 58, height: 58, borderRadius: "29px 29px 8px 8px", background: VIOLET }} />
      <div>
        <div style={{ fontSize: 36, fontWeight: 700 }}>Move to Hermes</div>
        <div style={{ fontSize: 26, color: "#9d95b8" }}>Move your Grok Bot bots to Hermes</div>
      </div>
    </div>
    <div style={{ padding: "10px 30px 30px" }}>{children}</div>
  </div>
);

const Bubble: React.FC<{ from: "bot" | "user"; delay: number; children: React.ReactNode; size?: number }> = ({
  from,
  delay,
  children,
  size = 34,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const user = from === "user";
  return (
    <div style={{ display: "flex", justifyContent: user ? "flex-end" : "flex-start", marginTop: 24, ...appear(frame, fps, delay) }}>
      <div
        style={{
          maxWidth: "86%",
          background: user ? USER_BG : BOT_BG,
          border: user ? "none" : "2px solid #2e2850",
          borderRadius: user ? "30px 30px 8px 30px" : "30px 30px 30px 8px",
          padding: "22px 28px",
          fontSize: size,
          lineHeight: 1.42,
          color: "#f2eeff",
          whiteSpace: "pre-wrap",
        }}
      >
        {children}
      </div>
    </div>
  );
};

const M: React.FC<{ children: React.ReactNode }> = ({ children }) => <span style={{ fontFamily: MONO, color: "#c4b5fd" }}>{children}</span>;

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontFamily: MONO, fontSize: 28, background: "#0a0912", borderRadius: 14, padding: "12px 16px", marginTop: 12, color: "#c4b5fd" }}>
    {children}
  </div>
);

// A choice card the bot posts; `picked` is the option the user chose (highlighted at `pickAt`).
const Choice: React.FC<{ prompt: string; options: string[]; picked: number; delay: number; pickAt: number }> = ({
  prompt,
  options,
  picked,
  delay,
  pickAt,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const on = frame >= pickAt;
  return (
    <div style={{ marginTop: 24, maxWidth: "92%", ...appear(frame, fps, delay) }}>
      <div style={{ background: BOT_BG, border: "2px solid #2e2850", borderRadius: 30, padding: "24px 28px" }}>
        <div style={{ fontSize: 33, fontWeight: 700, marginBottom: 14 }}>{prompt}</div>
        {options.map((option, i) => (
          <div
            key={option}
            style={{
              marginTop: 12,
              padding: "16px 22px",
              borderRadius: 18,
              fontSize: 30,
              border: `2px solid ${on && i === picked ? VIOLET : "#3a3358"}`,
              background: on && i === picked ? "#3b2a7a" : "transparent",
              color: on && i === picked ? "white" : "#cfc8e8",
            }}
          >
            {option}
          </div>
        ))}
      </div>
    </div>
  );
};

const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <div style={{ position: "absolute", top: 470, left: SIDE, right: SIDE, ...appear(frame, fps) }}>
        <div style={{ fontSize: 46, color: VIOLET, fontWeight: 700 }}>A Grok Bot bot</div>
        <div style={{ fontSize: 124, fontWeight: 850, lineHeight: 1.03, marginTop: 18 }}>Move to Hermes</div>
        <div style={{ fontSize: 50, color: "#e9e4ff", marginTop: 36, lineHeight: 1.35 }}>
          在 Grok Bot 裡說一句，它在你的電腦上幫你把 bot 搬到 Hermes。
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 160, left: SIDE, right: SIDE, fontSize: 34, color: "#a59cc4", ...appear(frame, fps, 12) }}>
        真實對話紀錄（2026-11-09）重新排版成手機畫面
      </div>
    </Backdrop>
  );
};

const Ask: React.FC = () => (
  <Backdrop>
    <Caption step="1 · ASK" title="Just ask" zh="跟它說要搬哪個 bot，它會先問要在哪台電腦上跑。" />
    <Chat>
      <Bubble from="user" delay={8}>你好，幫我把「Demo · Trip Planner」這個 bot 搬到 Hermes。</Bubble>
      <Bubble from="bot" delay={32}>好，我們一步一步來，每個指令都在你自己的電腦上跑，跑之前會先給你看。</Bubble>
      <Choice
        prompt="要在哪台電腦上搬到 Hermes？"
        options={["ImL1sdeMacBook-Pro-4.local", "MacBook-Pro-5.local", "win_desktop"]}
        picked={0}
        delay={62}
        pickAt={110}
      />
    </Chat>
  </Backdrop>
);

const CHECKS: [string, string][] = [
  ["hermes --version", "Hermes 有裝，v0.21.5"],
  ["node --version", "Node v25.9.0，符合需求"],
  ["gbot migrate --help", "gbot 已經裝好，有 migrate"],
  ["gbot migrate bots", "清單裡有「Demo · Trip Planner」"],
];

const Checks: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <Caption step="2 · CHECK" title="Your computer first" zh="每條指令都先問你「可以執行嗎？」，這幾條只讀，不改任何東西。" />
      <Chat>
        {CHECKS.map(([command, result], i) => (
          <div key={command} style={{ ...appear(frame, fps, 8 + i * 22) }}>
            <Bubble from="bot" delay={8 + i * 22} size={31}>
              <Code>{command}</Code>
              <div style={{ marginTop: 10 }}>可以執行嗎？</div>
            </Bubble>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, ...appear(frame, fps, 18 + i * 22) }}>
              <div style={{ fontSize: 30, color: "#34d399", paddingLeft: 8 }}>✓ {result}</div>
              <div style={{ background: USER_BG, borderRadius: 24, padding: "10px 24px", fontSize: 30 }}>可以。</div>
            </div>
          </div>
        ))}
      </Chat>
    </Backdrop>
  );
};

const PREVIEW = [
  "角色設定 → SOUL.md",
  "3 筆關於你的資料 → USER.md",
  "4 筆記憶（1 筆是還沒完成的待辦）",
  "103 個 skill 資料夾",
  "1 個排程，建立時是暫停的",
  "17 則對話紀錄、321 個檔案",
  "沒有找到任何金鑰或 token",
];

const Preview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <Caption step="3 · PREVIEW" title="See it before it moves" zh="預覽完成，什麼都還沒匯入：Hermes 會收到什麼、哪些搬不過去。" />
      <Chat>
        <Bubble from="bot" delay={6} size={31}>
          <div>預覽完成，什麼都還沒匯入。Hermes 會新建一個叫 <M>grok-demo</M> 的 profile，會收到這些：</div>
          {PREVIEW.map((line, i) => (
            <div key={line} style={{ marginTop: 8, ...appear(frame, fps, 18 + i * 8) }}>
              • {line}
            </div>
          ))}
          <div style={{ marginTop: 16, color: "#cfc8e8", ...appear(frame, fps, 84) }}>
            搬不過去的有這些：工具呼叫和系統事件、2 筆已完成的待辦（留在你電腦上的私人封存裡）、Grok Bot 平台內建的 skill，還有連線登入。
          </div>
        </Bubble>
      </Chat>
    </Backdrop>
  );
};

const Routines: React.FC = () => (
  <Backdrop>
    <Caption step="4 · YOUR CHOICE" title="Routines: you decide" zh="預設選 1：Grok Bot 那邊什麼都不會改。" />
    <Chat>
      <Bubble from="bot" delay={6} size={31}>這個 bot 有 1 個開著的排程：「Kyoto fares below TWD 9,000」，每週一 09:00（台北時間）跑。</Bubble>
      <Choice
        prompt="「Kyoto fares below TWD 9,000」這個排程要怎麼處理？"
        options={["1. Hermes 先關著，Grok Bot 照跑（預設）", "2. 兩邊都跑，可能跑兩次", "3. 搬過去：Grok Bot 暫停，Hermes 開啟"]}
        picked={0}
        delay={30}
        pickAt={95}
      />
      <Bubble from="user" delay={110} size={31}>排程選 1：Hermes 先關著，Grok Bot 照跑</Bubble>
    </Chat>
  </Backdrop>
);

const Confirm: React.FC = () => (
  <Backdrop>
    <Caption step="5 · CONFIRM" title="Nothing moves without a yes" zh="它把正式匯入的指令給你看，等你確定才跑。" />
    <Chat>
      <Bubble from="bot" delay={6} size={31}>
        這是正式匯入的指令，不加任何排程選項：
        <Code>gbot migrate run --bot "d893d0cd-…" --to hermes --yes</Code>
        <div style={{ marginTop: 12 }}>跑下去會在你的 Mac 上新建 Hermes profile <M>grok-demo</M>，把上面預覽列的內容寫進去，然後讀回來比對、跑驗收。確定要匯入嗎？</div>
      </Bubble>
      <Bubble from="user" delay={70}>確定，匯入吧。</Bubble>
      <Bubble from="bot" delay={95} size={31}>好，開始匯入，會重新抓一次資料再寫進 Hermes，大概要幾分鐘。</Bubble>
    </Chat>
  </Backdrop>
);

const Result: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <Caption step="6 · DONE" title="Moved and checked" zh="匯入後從 Hermes 讀回每一項，再問搬過去的 bot 只有搬過去的資料才答得出的問題。" />
      <Chat>
        <Bubble from="bot" delay={6} size={30}>
          {RESULT_LINES.map((line, i) => (
            <div key={i} style={{ marginTop: i ? 8 : 0, ...appear(frame, fps, 10 + i * 7) }}>
              {line}
            </div>
          ))}
        </Bubble>
      </Chat>
    </Backdrop>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <div style={{ position: "absolute", top: 560, left: SIDE, right: SIDE, ...appear(frame, fps) }}>
        <div style={{ fontSize: 92, fontWeight: 850, lineHeight: 1.05 }}>Move to Hermes</div>
        <div style={{ fontSize: 44, color: VIOLET, marginTop: 26, fontFamily: MONO }}>x.ai/bot/y2AFnYLdbz5T66loRBHar</div>
        <div style={{ fontSize: 42, color: "#e9e4ff", marginTop: 60, lineHeight: 1.45 }}>打開連結，加進你的 Grok Bot，說「幫我搬到 Hermes」。</div>
        <div style={{ fontSize: 36, color: "#bfb6dc", marginTop: 30, lineHeight: 1.45 }}>
          Open the link, add it to Grok Bot, and ask it to move a bot. It runs the open-source gbot on your own computer. Unofficial; not affiliated with xAI.
        </div>
      </div>
    </Backdrop>
  );
};

export const MOVE_TO_HERMES_SCENES = [
  { name: "Title", seconds: 3.5, Component: Title },
  { name: "Ask", seconds: 6, Component: Ask },
  { name: "Checks", seconds: 6.5, Component: Checks },
  { name: "Preview", seconds: 9, Component: Preview },
  { name: "Routines", seconds: 6.5, Component: Routines },
  { name: "Confirm", seconds: 6, Component: Confirm },
  { name: "Result", seconds: 9, Component: Result },
  { name: "Outro", seconds: 4.5, Component: Outro },
];

export const moveToHermesFrames = (fps: number) => MOVE_TO_HERMES_SCENES.reduce((sum, scene) => sum + Math.round(scene.seconds * fps), 0);

export const MoveToHermes: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#08070d" }}>
      <Series>
        {MOVE_TO_HERMES_SCENES.map(({ name, seconds, Component }) => (
          <Series.Sequence key={name} name={name} durationInFrames={Math.round(seconds * fps)}>
            <Component />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};
