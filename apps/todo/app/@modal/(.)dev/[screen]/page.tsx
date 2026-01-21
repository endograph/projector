"use client";

import { DevPanelContent } from "../../../components/DevPanelContent";
import { useModalClose } from "../../../components/ModalContext";
import { use } from "react";

type Screen = "overview" | "state" | "history" | "nodes" | "packs";

export default function DevModal({
  params,
}: {
  params: Promise<{ screen: string }>;
}) {
  const closeModal = useModalClose();
  const { screen } = use(params);
  const validScreen = ["overview", "state", "history", "nodes", "packs"].includes(screen)
    ? (screen as Screen)
    : "overview";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => closeModal()}
    >
      <div
        className="max-h-[85vh] w-full max-w-4xl overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <DevPanelContent screen={validScreen} isModal={true} />
      </div>
    </div>
  );
}
