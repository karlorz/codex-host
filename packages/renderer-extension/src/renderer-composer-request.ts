/** Native question/approval editors and actions are separate from chat submission. */
export const NATIVE_COMPOSER_REQUEST_ATTRIBUTES = [
  "data-codex-composer-request-navigation",
  "data-codex-composer-request",
] as const;
const NATIVE_REQUEST_SELECTOR = NATIVE_COMPOSER_REQUEST_ATTRIBUTES.map(
  (attribute) => `[${attribute}]`,
).join(", ");

export function isNativeComposerRequest(element: Element): boolean {
  return element.closest(NATIVE_REQUEST_SELECTOR) !== null;
}

/** Leave the native request's answer row available while it occupies a Composer root. */
export function hasNativeComposerRequest(composer: Element): boolean {
  return (
    isNativeComposerRequest(composer) || composer.querySelector(NATIVE_REQUEST_SELECTOR) !== null
  );
}
