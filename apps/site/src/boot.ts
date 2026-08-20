// Boot: the only JS the marketing page pays for beyond its inline scripts.
// Owns the handoff from static page to conversation: warm the app chunk the
// moment the visitor shows intent, then morph the hero composer into the
// conversation composer on submit. The React app is never imported unless
// intent happens, so the landing stays static-page fast.

import { listStoredSessions, removeStoredSession } from "./sessions-store";

type AppModule = typeof import("./app/main");

const root = document.documentElement;
const page = document.querySelector<HTMLElement>(".page")!;
const talk = document.querySelector<HTMLFormElement>("#talk")!;
const talkCard = talk.querySelector<HTMLElement>(".talk-card")!;
const talkInput = talk.querySelector<HTMLInputElement>(".talk-input")!;
const talkClear = talk.querySelector<HTMLButtonElement>(".talk-clear")!;

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
  opts: { initialMessage?: string; initialTopic?: string; sessionId?: string },
) => {
  root.classList.add("launching");
  return withTransition(() => {
    root.dataset.app = "1";
    page.inert = true;
    // Mounts synchronously (flushSync inside) so the view transition's new
    // snapshot already contains the conversation with the composer in place.
    mod.launch(opts);
  }).then(() => root.classList.remove("launching"));
};

const exitApp = async () => {
  const mod = await loadApp();
  await withTransition(() => {
    delete root.dataset.app;
    page.inert = false;
    mod.unmount();
  });
  refreshPastLink();
};

// Already home: the brand is a no-op instead of a same-page reload.
document.querySelector<HTMLAnchorElement>(".nav-brand")?.addEventListener("click", (e) => {
  if (location.pathname === "/") e.preventDefault();
});

// Past conversations: a device-local pointer list (see sessions-store.ts).
// The link under the composer appears once anything is stored; the dialog
// lists sessions newest-first and opens straight into the conversation.
const pastLink = document.querySelector<HTMLButtonElement>(".talk-past");
const pastDialog = document.querySelector<HTMLDialogElement>(".past-dialog");
const refreshPastLink = () => {
  if (pastLink) pastLink.hidden = listStoredSessions().length === 0;
};
refreshPastLink();
// bfcache restores skip boot: re-check on every pageshow so returning from a
// conversation (or another tab's work) surfaces the link.
addEventListener("pageshow", refreshPastLink);

const relativeTime = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const renderPastSessions = () => {
  const list = pastDialog?.querySelector<HTMLElement>(".past-list");
  if (!list) return;
  list.replaceChildren(
    ...listStoredSessions().map((session) => {
      const row = document.createElement("div");
      row.className = "past-row";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "past-open";
      const title = document.createElement("span");
      title.className = "past-title";
      title.textContent = session.title || "untitled conversation";
      const when = document.createElement("span");
      when.className = "past-when";
      when.textContent = relativeTime(session.at);
      open.append(title, when);
      open.addEventListener("click", async () => {
        pastDialog?.close();
        const mod = await loadApp();
        history.pushState({ app: true }, "", `/s/${session.id}`);
        await enterApp(mod, { sessionId: session.id });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "past-remove";
      remove.textContent = "×";
      remove.title = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${session.title || "untitled conversation"} from past conversations`,
      );
      remove.addEventListener("click", () => {
        if (!remove.hasAttribute("data-confirm")) {
          for (const armed of list.querySelectorAll<HTMLButtonElement>(".past-remove[data-confirm]")) {
            const armedTitle = armed
              .closest(".past-row")
              ?.querySelector<HTMLElement>(".past-title")
              ?.textContent || "untitled conversation";
            armed.removeAttribute("data-confirm");
            armed.textContent = "×";
            armed.title = "Remove";
            armed.setAttribute(
              "aria-label",
              `Remove ${armedTitle} from past conversations`,
            );
          }
          remove.setAttribute("data-confirm", "");
          remove.textContent = "confirm";
          remove.title = "Confirm removal";
          remove.setAttribute(
            "aria-label",
            `Confirm removal of ${session.title || "untitled conversation"} from past conversations`,
          );
          return;
        }
        removeStoredSession(session.id);
        renderPastSessions();
        refreshPastLink();
        if (listStoredSessions().length === 0) pastDialog?.close();
      });

      row.append(open, remove);
      return row;
    }),
  );
};

pastLink?.addEventListener("click", () => {
  if (!pastDialog) return;
  renderPastSessions();
  pastDialog.showModal();
});
// A click on the dialog element itself is a click on the backdrop.
pastDialog?.addEventListener("click", (e) => {
  if (e.target === pastDialog) pastDialog.close();
});

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
  if (resting && restTimer === undefined) restTimer = setInterval(restAdvance, 7000);
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
    }, 1200);
    const band = document.querySelector<HTMLElement>(".talk-explainers");
    band?.addEventListener("pointerenter", restPause);
    band?.addEventListener("pointerleave", restResume);
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
for (const hot of hotWords) {
  const ask = hot.dataset.ask ?? "";
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
    previewAsk(ask);
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
      previewAsk(ask);
      return;
    }
    touchTap = false;
    commitPreview();
    talkInput.value = ask;
    talk.requestSubmit();
  });
}

for (const prompt of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  const ask = prompt.dataset.prompt ?? "";
  prompt.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    previewAsk(ask);
  });
  prompt.addEventListener("click", () => {
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
  if (root.dataset.app || pastDialog?.open || editing || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
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
  const sessionId = location.pathname.split("/")[2];
  loadApp().then((mod) => {
    page.inert = true;
    mod.launch({ sessionId: sessionId === "new" ? undefined : sessionId });
  });
}

// Back returns to the marketing page; forward re-enters the conversation.
addEventListener("popstate", () => {
  const inApp = /^\/s\//.test(location.pathname);
  if (inApp && !root.dataset.app) {
    const sessionId = location.pathname.split("/")[2];
    loadApp().then((mod) => enterApp(mod, { sessionId: sessionId === "new" ? undefined : sessionId }));
  } else if (!inApp && root.dataset.app) {
    void exitApp();
  }
});
