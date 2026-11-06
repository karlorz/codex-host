# Browser annotation cursor compatibility

Codex Desktop's built-in browser hides the native mouse cursor while Annotate
draws an SVG replacement. The annotation runtime puts the replacement's positioning
rules in a `style` element inside the shadow root of
`#codex-browser-sidebar-comments-root`. A page policy such as `style-src 'self'`
can reject that inline stylesheet while allowing the runtime's individual CSSOM
style assignments. The overlay can then hide the native pointer without a
correctly positioned replacement.

This was observed on the Fleet Board live panel. Its annotation stylesheet had
`sheet === null`; adopting the same CSS as a constructed stylesheet restored the
cursor, and the user confirmed it was visible with Annotate active. The panel's
`.cur` terminal caret is unrelated.

## Host behavior

`packages/desktop-control/src/browser-annotation-style-compat.ts` supplies a
dedicated shim. The production CDP controller installs it on HTTP(S) page targets
inside Desktop's renderer endpoint, both in their current document and through
`Page.addScriptToEvaluateOnNewDocument` for subsequent navigation. Health checks
discover newly opened targets and refresh existing hooks. Registrations are
deduplicated for each target during a controller session. The controller retains
one dedicated CDP connection per browser target because Chromium removes
new-document registrations when that connection detaches. Closed targets,
failed connections, and controller shutdown release those connections.

The shim changes only the known annotation root, which Desktop appends directly
to the document element. When its shadow tree contains a rejected `style` element
with `.annotation-selection-cursor` rules, it adopts a constructed copy of that
stylesheet. It tracks stylesheet changes, removal, and root replacement. A shadow
root attached asynchronously is discovered on the next controller health check;
shadow attachment itself does not emit a light-DOM mutation. Repeated installation does not accumulate observers or
copies. Existing adopted sheets and accepted inline styles remain in place.

The shim does not inject the Host chat Renderer binding into websites, change
response headers, enable inline scripts or styles globally, disable CSP, add
pointer capture, or change annotation interaction semantics. Pages without the
known annotation root receive no stylesheet changes. Missing browser APIs or a
changed upstream root/style contract leave upstream behavior intact. Auxiliary
target failures do not make the primary chat session unavailable.

This compatibility hook is part of the production renderer-CDP controller path.
The legacy main-process Inspector session does not install it. Installing a build
containing the change is necessary for automatic repair after application restarts;
a repair evaluated manually in one tab lasts only until that document is replaced.

## Focused validation

- `packages/desktop-control/test/browser-annotation-style-install.test.ts` covers
  target filtering, dedicated-source ownership, future-document registration,
  health-check discovery, reload recovery, deduplication, and closed-page isolation.
- `tests/e2e/browser-annotation-style-csp.spec.ts` reproduces stylesheet rejection
  under a strict page policy, verifies the cursor position after repair and reload,
  and checks accepted-style preservation, update/removal, unrelated shadow roots,
  and annotation-root replacement in Chromium.

The synthetic browser fixture verifies the CSS mechanism and injection lifecycle;
it is not a replacement for Annotate acceptance on each future Desktop release.
