import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AppError from "@/app/(app)/error";
import GlobalError from "@/app/global-error";
import NotFound, { metadata } from "@/app/not-found";

const boom = Object.assign(new Error("db down"), { digest: "abc123" });

describe("designed error and not-found pages", () => {
  it("app error page offers a retry, a way back, a title and the reference", () => {
    const out = renderToStaticMarkup(h(AppError, { error: boom, retry: () => {} }));
    expect(out).toContain("<title>Something went wrong · Invoice Chaser</title>");
    expect(out).toMatch(/<h1[^>]*tabindex="-1"[^>]*>This page didn(&#x27;|')t load<\/h1>/);
    expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(out).toMatch(/<a [^>]*href="\/"[^>]*>Go to dashboard<\/a>/);
    expect(out).toContain("abc123");
    expect(out).not.toContain("db down"); // never show the raw message
  });

  it("app error page copes with a thrown non-Error", () => {
    const out = renderToStaticMarkup(h(AppError, { error: "nope", retry: () => {} }));
    expect(out).toContain("Try again");
    expect(out).not.toContain("quote");
  });

  it("global error page renders its own document with retry and a way back", () => {
    const out = renderToStaticMarkup(h(GlobalError, { error: boom, retry: () => {} }));
    expect(out).toMatch(/^<html lang="en"><head>.*<title>Something went wrong · Invoice Chaser<\/title>.*<\/head><body/);
    expect(out).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(out).toMatch(/<a href="\/"[^>]*>Go to dashboard<\/a>/);
  });

  it("not-found page has a title and links back", () => {
    expect(metadata.title).toBe("Page not found");
    const out = renderToStaticMarkup(h(NotFound));
    expect(out).toContain("We couldn&#x27;t find that page");
    expect(out).toMatch(/<a [^>]*href="\/"[^>]*>Go to dashboard<\/a>/);
    expect(out).toMatch(/<a [^>]*href="\/invoices"[^>]*>View invoices<\/a>/);
  });
});
