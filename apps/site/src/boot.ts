// Boot owns the handoff from the marketing page to a conversation. The app
// chunk also mounts the authenticated past-conversations island on the
// landing page, while the full conversation UI remains unmounted until used.

type AppModule = typeof import("./app/main");

const root = document.documentElement;
const page = document.querySelector<HTMLElement>(".page")!;
const talk = document.querySelector<HTMLFormElement>("#talk")!;
const talkCard = talk.querySelector<HTMLElement>(".talk-card")!;
const talkInput = talk.querySelector<HTMLInputElement>(".talk-input")!;
const talkClear = talk.querySelector<HTMLButtonElement>(".talk-clear")!;
const talkMic = talk.querySelector<HTMLButtonElement>(".talk-mic")!;
const projectActions = document.querySelector<HTMLElement>(".page .start")!;
const projectActionsHome = projectActions.parentNode!;
const projectActionsHomeNext = projectActions.nextSibling;

const mountProjectActions = () => {
  document.querySelector<HTMLElement>("[data-app-nav-actions]")?.append(projectActions);
};
const restoreProjectActions = () => {
  projectActionsHome.insertBefore(projectActions, projectActionsHomeNext);
};

let appPromise: Promise<AppModule> | null = null;

const loadApp = () => {
  if (!appPromise) {
    appPromise = import("./app/main").then((mod) => {
      mod.warm();
      return mod;
    });
  }
  return appPromise;
};

// A view transition when the browser has them and the visitor hasn't asked
// for stillness; a plain cut otherwise. The morph itself is declared in CSS
// via view-transition-name on the two composer cards.
const still = matchMedia("(prefers-reduced-motion: reduce)");
const withTransition = (mutate: () => void) => {
  if (!still.matches && document.startViewTransition) {
    return document.startViewTransition(mutate).finished.catch(() => {});
  }
  mutate();
  return Promise.resolve();
};

const enterApp = (
  mod: AppModule,
  opts: {
    initialMessage?: string;
    initialTopic?: string;
    sessionId?: string;
    route?: "conversation" | "sessions";
  },
) => {
  root.classList.add("launching");
  return withTransition(() => {
    root.dataset.app = "1";
    page.inert = true;
    // Mounts synchronously (flushSync inside) so the view transition's new
    // snapshot already contains the conversation with the composer in place.
    mod.launch(opts);
    mountProjectActions();
  }).then(() => root.classList.remove("launching"));
};

const exitApp = async () => {
  const mod = await loadApp();
  // Keep the expensive decorative layers out of the transition's new-page
  // snapshot. Once the morph is finished, the landing's own tracker resets
  // and replays its original beam → wash intro.
  root.classList.add("light-reset");
  await withTransition(() => {
    restoreProjectActions();
    delete root.dataset.app;
    page.inert = false;
    mod.unmount();
  });
  root.dispatchEvent(new Event("projector:replay-light"));
};

// Already home: the brand is a no-op instead of a same-page reload.
document.querySelector<HTMLAnchorElement>(".nav-brand")?.addEventListener("click", (e) => {
  if (location.pathname === "/") e.preventDefault();
});

const openPastConversation = async (sessionId: string) => {
  const mod = await loadApp();
  history.pushState({ app: true }, "", `/s/${sessionId}`);
  await enterApp(mod, { sessionId });
};

// This island owns the auth-aware history link while the marketing page is
// visible. launch() unmounts it; unmount() restores it when leaving chat.
void loadApp().then((mod) => mod.mountPastConversations(openPastConversation));

// Intent warms the chunk: hovering near the composer, focusing it, or even
// touching the page at all after a beat. By the time enter is pressed the
// module and the Convex socket should both be up.
talk.addEventListener("pointerenter", loadApp, { once: true });
talkInput.addEventListener("focus", loadApp, { once: true });
addEventListener("pointerdown", loadApp, { once: true });
setTimeout(loadApp, 8000);

// Set by a demo card just before it submits: the turn opens as a prebuilt
// rich explainer (see convex/topics.ts) instead of a model call.
let pendingTopic: string | undefined;

talk.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = talkInput.value.trim() || talkInput.placeholder.trim();
  if (!text) return;
  const initialTopic = pendingTopic;
  pendingTopic = undefined;
  retireResting();
  talkCard.classList.add("talk-waiting");
  try {
    const mod = await loadApp();
    history.pushState({ app: true }, "", "/s/new");
    await enterApp(mod, { initialMessage: text, initialTopic });
  } finally {
    talkCard.classList.remove("talk-waiting");
    talkInput.value = "";
  }
});

// Headline hot words leave a suggested value in the composer. It persists
// until another target suggests something or the visitor starts editing.
const previewAsk = (ask: string) => {
  talkInput.placeholder = ask;
  talkInput.toggleAttribute("data-suggested", true);
};
const commitPreview = () => {
  talkInput.removeAttribute("data-suggested");
  talkInput.placeholder = "hi";
};
const hotWords = [...document.querySelectorAll<HTMLButtonElement>(".hero h1 .hot")];
const explainerBand = document.querySelector<HTMLElement>(".talk-explainers")!;
const categoryCards = [
  ...explainerBand.querySelectorAll<HTMLButtonElement>(
    ".explainer:not(.explainer-rest) > button",
  ),
];
const bonusCards = [
  ...document
    .querySelector<HTMLTemplateElement>("#default-card-bonuses")!
    .content.querySelectorAll<HTMLButtonElement>("button"),
];
const defaultCards = [...categoryCards, ...bonusCards];
for (let index = 0; index < defaultCards.length; index += 2) {
  const panel = document.createElement("div");
  panel.className = "explainer explainer-rest";
  panel.dataset.explainer = `rest-${index / 2}`;
  panel.setAttribute("aria-hidden", "true");
  panel.append(defaultCards[index].cloneNode(true));
  // An odd final card wraps to the first so the resting state always shows
  // a pair while still visiting every default card in order.
  panel.append(defaultCards[(index + 1) % defaultCards.length].cloneNode(true));
  explainerBand.append(panel);
}
const explainers = [...document.querySelectorAll<HTMLElement>("[data-explainer]")];

// On phones a panel is a single column two cards tall; a panel holding more
// pages through them in pairs, riding the panel's own opacity transition so
// each page change reads like the panel swaps the site already does.
const mobileMq = matchMedia("(max-width: 775px)");
let cardTimer: ReturnType<typeof setInterval> | undefined;
let cardPanel: HTMLElement | undefined;
const showCardPage = (panel: HTMLElement, page: number) => {
  for (const [i, card] of [...panel.querySelectorAll("button")].entries()) {
    card.toggleAttribute("data-cycle-hidden", Math.floor(i / 2) !== page);
  }
};
const cycleCards = (panel: HTMLElement | undefined) => {
  clearInterval(cardTimer);
  cardTimer = undefined;
  if (cardPanel) cardPanel.style.opacity = "";
  cardPanel = panel;
  if (!panel) return;
  const count = panel.querySelectorAll("button").length;
  if (!mobileMq.matches || count <= 2) {
    for (const card of panel.querySelectorAll("[data-cycle-hidden]")) {
      card.removeAttribute("data-cycle-hidden");
    }
    return;
  }
  showCardPage(panel, 0);
  if (still.matches) return; // first pair, static
  const pages = Math.ceil(count / 2);
  let page = 0;
  cardTimer = setInterval(() => {
    page = (page + 1) % pages;
    panel.style.opacity = "0";
    setTimeout(() => {
      if (cardPanel !== panel) return;
      showCardPage(panel, page);
      panel.style.opacity = "";
    }, 340);
  }, 5000);
};
mobileMq.addEventListener("change", () => cycleCards(cardPanel));

const showExplainer = (topic: string | undefined) => {
  let activePanel: HTMLElement | undefined;
  for (const explainer of explainers) {
    const active = explainer.dataset.explainer === topic;
    explainer.toggleAttribute("data-active", active);
    explainer.setAttribute("aria-hidden", String(!active));
    if (active) activePanel = explainer;
  }
  cycleCards(activePanel);
};
const activateHotWord = (hot: HTMLButtonElement) => {
  retireResting();
  for (const word of hotWords) {
    const active = word === hot;
    word.toggleAttribute("data-active", active);
    word.setAttribute("aria-pressed", String(active));
  }
  showExplainer(hot.dataset.topic);
};

// Resting cards: while nothing is engaged, the band below the composer slowly
// cycles through a few things worth asking. First real intent — a hot word,
// typing — retires the cycle for good; hovering the band pauses it.
const restTopics = explainers
  .map((el) => el.dataset.explainer ?? "")
  .filter((topic) => topic.startsWith("rest-"));
let restIndex = 0;
let restTimer: ReturnType<typeof setInterval> | undefined;
let resting = restTopics.length > 0 && !root.dataset.app;
const restAdvance = () => {
  showExplainer(restTopics[restIndex % restTopics.length]);
  restIndex += 1;
};
const restResume = () => {
  if (resting && restTimer === undefined) restTimer = setInterval(restAdvance, 4900);
};
const restPause = () => {
  clearInterval(restTimer);
  restTimer = undefined;
};
const retireResting = (clear = false) => {
  if (!resting) return;
  resting = false;
  restPause();
  // Later changes are visitor-driven, so announcing them is wanted again.
  document.querySelector(".talk-explainers")?.setAttribute("aria-live", "polite");
  if (clear) showExplainer(undefined);
};
if (resting) {
  if (still.matches) restAdvance(); // one static card, no motion
  else {
    setTimeout(() => {
      if (!resting) return;
      restAdvance();
      restResume();
    }, 840);
    explainerBand.addEventListener("pointerenter", restPause);
    explainerBand.addEventListener("pointerleave", restResume);
  }
}
talkInput.addEventListener("input", () => {
  commitPreview();
  retireResting(true); // typing means engaged — fade the suggestion out of the way
});
talkInput.addEventListener("beforeinput", () => {
  if (talkInput.hasAttribute("data-suggested")) {
    commitPreview();
  }
});
talkClear.addEventListener("click", () => {
  commitPreview();
  talkInput.value = "";
  talkInput.focus({ preventScroll: true });
  talkInput.dispatchEvent(new Event("input", { bubbles: true }));
});
talkMic.addEventListener("click", () => window.alert("voice coming soon"));
for (const hot of hotWords) {
  // Touch has no hover, so the first tap plays the hover role: activate the
  // word, preview its question in the composer, and grow the send badge (CSS
  // on [data-active]). A second tap on the armed word sends. Mouse clicks
  // (and keyboard activation) still send immediately — hover already
  // previewed. Armed-ness is read at pointerdown: the tap's own focus event
  // activates the word before click lands, so click can't tell first tap
  // from second on its own.
  let touchTap = false;
  let armedAtTap = false;
  hot.addEventListener("pointerenter", (e) => {
    loadApp();
    if (e.pointerType !== "mouse") return;
    activateHotWord(hot);
    previewAsk(hot.dataset.ask ?? "");
  });
  hot.addEventListener("pointerdown", (e) => {
    touchTap = e.pointerType !== "mouse";
    armedAtTap = hot.hasAttribute("data-active");
  });
  hot.addEventListener("focus", () => activateHotWord(hot));
  hot.addEventListener("click", () => {
    activateHotWord(hot);
    if (touchTap && !armedAtTap) {
      touchTap = false;
      previewAsk(hot.dataset.ask ?? "");
      return;
    }
    touchTap = false;
    commitPreview();
    talkInput.value = hot.dataset.ask ?? "";
    talk.requestSubmit();
  });
}

for (const prompt of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  const ask = prompt.dataset.prompt ?? "";
  prompt.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    previewAsk(ask);
  });
  prompt.addEventListener("click", (e) => {
    // Citation marks sit inside the button (a link can't); clicking one opens
    // its reference instead of submitting the card's prompt.
    const mark = (e.target as HTMLElement).closest<HTMLElement>("[data-link]");
    if (mark) {
      window.open(mark.dataset.link, "_blank", "noopener");
      return;
    }
    commitPreview();
    talkInput.value = ask;
    pendingTopic = prompt.dataset.demo;
    talk.requestSubmit();
  });
}

// Look ready without stealing focus. The first printable key pressed anywhere
// on the marketing page is moved into the composer.
addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  const editing = target?.matches("input, textarea, select, [contenteditable]");
  const historyOpen = document.querySelector<HTMLDialogElement>(".past-dialog")?.open;
  if (root.dataset.app || historyOpen || editing || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  e.preventDefault();
  talkInput.focus({ preventScroll: true });
  if (talkInput.hasAttribute("data-suggested")) {
    commitPreview();
  }
  const start = talkInput.selectionStart ?? talkInput.value.length;
  const end = talkInput.selectionEnd ?? talkInput.value.length;
  talkInput.setRangeText(e.key, start, end, "end");
  talkInput.dispatchEvent(new Event("input", { bubbles: true }));
});

// Deep link (/s/:id): the head script already hid the marketing page before
// paint; go straight into the conversation.
if (root.dataset.app) {
  const sessionsRoute = location.pathname === "/sessions";
  const sessionId = sessionsRoute ? undefined : location.pathname.split("/")[2];
  loadApp().then((mod) => {
    page.inert = true;
    mod.launch({
      route: sessionsRoute ? "sessions" : "conversation",
      sessionId: sessionId === "new" ? undefined : sessionId,
    });
    mountProjectActions();
  });
}

// Back returns to the marketing page; forward re-enters the conversation.
addEventListener("popstate", () => {
  const inApp = /^\/s\//.test(location.pathname) || location.pathname === "/sessions";
  if (inApp && !root.dataset.app) {
    const sessionsRoute = location.pathname === "/sessions";
    const sessionId = sessionsRoute ? undefined : location.pathname.split("/")[2];
    loadApp().then((mod) => enterApp(mod, {
      route: sessionsRoute ? "sessions" : "conversation",
      sessionId: sessionId === "new" ? undefined : sessionId,
    }));
  } else if (!inApp && root.dataset.app) {
    void exitApp();
  }
});
