"use client";

import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  themeHueAtom,
  themeSaturationAtom,
  themeAnimatedAtom,
  themeGradientAtom,
  displayHueAtom,
} from "@/src/atoms";

interface ThemeProviderProps {
  children: React.ReactNode;
  theme?: {
    hue: number;
    saturation: number;
    animated: boolean;
    gradient: boolean;
  };
}

export function ThemeProvider({ children, theme }: ThemeProviderProps) {
  const setThemeHue = useSetAtom(themeHueAtom);
  const setThemeSaturation = useSetAtom(themeSaturationAtom);
  const setThemeAnimated = useSetAtom(themeAnimatedAtom);
  const setThemeGradient = useSetAtom(themeGradientAtom);
  const [displayHue, setDisplayHue] = useAtom(displayHueAtom);
  const animated = useAtomValue(themeAnimatedAtom);
  const gradient = useAtomValue(themeGradientAtom);
  const saturation = useAtomValue(themeSaturationAtom);
  const baseHue = useAtomValue(themeHueAtom);

  // Sync theme from props (session instance)
  useEffect(() => {
    if (theme) {
      setThemeHue(theme.hue);
      setThemeSaturation(theme.saturation);
      setThemeAnimated(theme.animated);
      setThemeGradient(theme.gradient);
      if (!theme.animated) {
        setDisplayHue(theme.hue);
      }
    }
  }, [
    theme,
    setThemeHue,
    setThemeSaturation,
    setThemeAnimated,
    setThemeGradient,
    setDisplayHue,
  ]);

  // Flux mode animation - smooth random walk through color space
  useEffect(() => {
    if (!animated) return;

    let animationId: number;
    let time = 0;
    const animate = () => {
      time += 0.005; // Speed of drift
      // Smooth random walk using sine waves with irrational frequencies
      const hue =
        (baseHue +
          Math.sin(time * 1.1) * 60 +
          Math.sin(time * 0.7) * 40 +
          Math.sin(time * 1.9) * 30) %
        360;
      setDisplayHue((hue + 360) % 360);
      animationId = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(animationId);
  }, [animated, baseHue, setDisplayHue]);

  // Apply CSS variables for colors
  useEffect(() => {
    const root = document.documentElement;
    const h = displayHue;
    const s = saturation;

    // Primary color (50% lightness for visibility on dark bg)
    root.style.setProperty("--terminal-green", `hsl(${h}, ${s}%, 50%)`);
    root.style.setProperty("--terminal-green-dim", `hsl(${h}, ${s}%, 35%)`);
    root.style.setProperty("--terminal-green-dimmer", `hsl(${h}, ${s}%, 25%)`);

    // Glow effect color
    root.style.setProperty("--glow-color", `hsla(${h}, ${s}%, 50%, 0.3)`);
  }, [displayHue, saturation]);

  // Apply gradient overlay CSS variables (independent of animation)
  useEffect(() => {
    const root = document.documentElement;

    if (gradient) {
      // Two-point gradient from hue to hue+120 (triadic harmony)
      root.style.setProperty("--gradient-hue-1", String(displayHue));
      root.style.setProperty(
        "--gradient-hue-2",
        String((displayHue + 120) % 360)
      );
      root.style.setProperty("--gradient-intensity", "1");
    } else {
      // No gradient overlay
      root.style.setProperty("--gradient-intensity", "0");
    }
  }, [gradient, displayHue]);

  return <>{children}</>;
}
