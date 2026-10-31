"use client";

import { useEffect } from "react";

const SELECTOR = "form, input:not([type='hidden']), select, textarea";

/**
 * Turns off the browser's autocomplete on every form and field of the app, the
 * ones that appear later too: its suggestions cover the app's own dropdowns and
 * offer old values that mean nothing here. In one place because no field should
 * have it and a new form must not need to remember. A field with its own
 * autocomplete keeps it, and so does anything inside [data-keep-autocomplete]
 * (the login, for the password manager).
 */
export function AutocompleteOff() {
  useEffect(() => {
    function apply(root: ParentNode) {
      const found = root.querySelectorAll(SELECTOR);
      const self = root instanceof Element && root.matches(SELECTOR) ? [root] : [];
      for (const element of [...self, ...found]) {
        if (element.hasAttribute("autocomplete") || element.closest("[data-keep-autocomplete]")) continue;
        element.setAttribute("autocomplete", "off");
      }
    }

    apply(document);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) apply(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
