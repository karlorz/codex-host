// Desktop 26.1027.30824 / build 22943, app-initial: native submission intent and admission.
// Captured for VM regression replay; surrounding services are supplied by the test.
(function Imn({ host: e, isActive: t, isDurableThread: n, getQueueMode: r, enqueue: i }) {
  return { sendMessage: a, submitPrepared: o, getQueueMode: s, getSubmissionIntent: l };
  async function a(e, r, a, l, d, f, p, m, h, g, _) {
    let { conversationId: v, message: y } = e,
      b = await s(e);
    if (u(e, b, a)) return i(v, y, e.editPosition, p, h, g, _?.() ?? y);
    let x = async (t) => {
        let i = await r(e, t),
          a = e.editPosition;
        if (a?.serverSubmission == null) return i;
        let o = a.serverSubmission,
          s = (e) =>
            w8t({
              input: e,
              context: y.context,
              previousSubmission: o,
              preserveSerializedContext: a.preserveSerializedContext === !0,
              isDurableThread: n(),
            }),
          c = (e) =>
            e == null ? void 0 : { ...e, request: { ...e.request, input: s(e.request.input) } };
        return {
          ...i,
          start: c(i.start),
          steer: {
            ...i.steer,
            input: s(i.steer.input),
            userMessageAdmissionStart: c(i.steer.userMessageAdmissionStart),
          },
        };
      },
      S = await x(`steer`);
    if (S.conversationId !== v) throw Error(`Prepared submission belongs to another thread`);
    try {
      let t = c(e, b) || S.requiresIdle === !0,
        n = await o(S, t ? `when-idle` : `send-now`, l, d, f, p, m, h);
      if (n.status === `needs-start-preparation`) {
        let r = n.afterInactiveTurnId;
        if (((S = await x(`start`)), S.conversationId !== v || S.start == null))
          throw Error(`Start preparation did not produce a matching turn request`);
        ((t = c(e, b) || S.requiresIdle === !0),
          (n = await o(
            { ...S, afterInactiveTurnId: r },
            t ? `when-idle` : `send-now`,
            l,
            d,
            f,
            p,
            m,
            h,
          )));
      }
      if (n.status === `deferred` && d != null && !d()) throw new yE();
      if (n.status === `deferred` && t)
        return await i(
          v,
          { ...y, context: S.steer.restoreMessage.context },
          e.editPosition,
          p,
          h,
          g,
          _?.() ?? y,
        );
      if (n.status !== `sent`) throw Error(`Explicit message submission was not sent`);
      return { ...n, messageId: y.id };
    } catch (n) {
      if (!t() || b === `send-only` || !Cpn(n)) throw n;
      if (d != null && !d()) throw new yE();
      return i(
        v,
        { ...y, context: S.steer.restoreMessage.context, pausedReason: void 0 },
        e.editPosition,
        p,
        h,
        g,
        _?.() ?? y,
      );
    }
  }
  async function o(n, r, i, a, o, s, c, l) {
    if (!t()) throw Error(`Turn coordinator retired`);
    let { conversationId: u } = n;
    if (n.resume.conversationId !== u)
      throw Error(`Resume request does not match the submission thread`);
    let d = null;
    if (e.needsResume(u)) {
      let t = await e.resume(n.resume, i);
      if (t.status === `not-ready`) throw new JT(t);
      d = t.activeTurnId;
    }
    if ((l != null && (await l()), !t())) throw Error(`Turn coordinator retired`);
    if (a != null && !a()) return { status: `deferred` };
    let f = e.getActiveTurnId(u) ?? d,
      p = e.hasPendingTurnStart(u),
      m = n.afterInactiveTurnId;
    if ((r === `when-idle` || n.requiresIdle === !0) && (f != null || p))
      return { status: `deferred` };
    if (f == null ? p : f !== m)
      try {
        return { status: `sent`, ...(await e.steer(u, n.steer, o, s, l)) };
      } catch (r) {
        if (
          !t() ||
          (!e.canStartAfterSteerError(u, r, n.executionHostId) &&
            !(n.allowStartAfterNoActiveTurn && ypn(r)))
        )
          throw r;
        (l != null && (await l()), await c?.(), (m = f ?? void 0));
      }
    return n.start == null
      ? { status: `needs-start-preparation`, afterInactiveTurnId: m }
      : a != null && !a()
        ? { status: `deferred` }
        : { status: `sent`, kind: `start`, turnId: await e.start(u, n.start, o, s, l) };
  }
  async function s(e) {
    let t = await r(e);
    return t === `send-only` ? t : (e.queueModeOverride ?? t);
  }
  function c(t, n) {
    return (
      n === `queue` ||
      (n !== `send-only` &&
        t.queueModeOverride !== `send-now` &&
        (e.hasPendingTurnStart(t.conversationId) || e.hasFinalAnswer(t.conversationId)))
    );
  }
  function l(t, n, r) {
    return u(t, n, r)
      ? `queue`
      : !r &&
          !e.needsResume(t.conversationId) &&
          e.getActiveTurnId(t.conversationId) == null &&
          !e.hasPendingTurnStart(t.conversationId)
        ? `start`
        : `send-now`;
  }
  function u(t, n, r) {
    return (
      n === `queue-only` ||
      (c(t, n) &&
        (r ||
          e.hasPendingTurnStart(t.conversationId) ||
          e.getActiveTurnId(t.conversationId) != null))
    );
  }
});
