"use client";

// The settings sub-page tabs. The active tab comes from the path, so the layout can render them once.
// On /settings it also forwards old single-page anchors (/settings#payments) to their sub-page.
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { SegmentedTabs } from "@/components/data";
import { activeSettingsPage, legacySettingsTarget, SETTINGS_PAGES } from "./settings-pages";

export function SettingsTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeSettingsPage(pathname);
  const wrapper = useRef<HTMLDivElement>(null);

  // On a phone the tabs scroll sideways. Keep the current one in view, so Account is not hidden off-screen.
  useEffect(() => {
    function reveal() {
      const current = wrapper.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const strip = current?.closest("nav");
      if (!current || !strip || strip.scrollWidth <= strip.clientWidth) return;
      const tab = current.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      strip.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
    }
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [active]);

  useEffect(() => {
    if (pathname !== "/settings" || !window.location.hash) return;
    const target = legacySettingsTarget(window.location.hash);
    if (target) router.replace(target);
  }, [pathname, router]);

  return (
    <div ref={wrapper}>
      <SegmentedTabs
        label="Settings pages"
        items={SETTINGS_PAGES.map((page) => ({ label: page.label, href: page.href, active: page.key === active }))}
      />
    </div>
  );
}
