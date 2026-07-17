export const SESSION_ARCHIVE_LONG_PRESS_MS = 550;
export const SESSION_ARCHIVE_SWIPE_DISTANCE_PX = 64;
export const SESSION_ARCHIVE_SWIPE_VERTICAL_TOLERANCE_PX = 32;

export function isDeliberateArchiveSwipe(startX: number, startY: number, endX: number, endY: number): boolean {
  return startX - endX >= SESSION_ARCHIVE_SWIPE_DISTANCE_PX &&
    Math.abs(endY - startY) <= SESSION_ARCHIVE_SWIPE_VERTICAL_TOLERANCE_PX;
}
export type SessionListItem = {
  id: string;
  rootSessionId: string;
  title: string;
  adapter: string;
  status: string;
  updatedAt: string;
  archivedAt?: string | null;
  actionableCount?: number;
};

export type SessionSection<T> = { heading: string; items: T[] };

export function sessionSections<T extends { actionableCount?: number }>(items: T[]): SessionSection<T>[] {
  return [
    { heading: "Needs your input", items: items.filter((item) => (item.actionableCount ?? 0) > 0) },
    { heading: "Recently active", items: items.filter((item) => (item.actionableCount ?? 0) === 0) },
  ].filter((section) => section.items.length > 0);
}

export function rootSessionSections<T extends { id: string; rootSessionId?: string; actionableCount?: number }>(
  items: T[],
): SessionSection<T>[] {
  return sessionSections(items.filter((item) => item.rootSessionId === item.id));
}

export function historySections<T extends { updatedAt: string }>(
  items: T[],
  formatDate: (updatedAt: string) => string = (updatedAt) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(updatedAt)),
): SessionSection<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const heading = formatDate(item.updatedAt);
    groups.set(heading, [...(groups.get(heading) ?? []), item]);
  }
  return [...groups].map(([heading, groupedItems]) => ({ heading, items: groupedItems }));
}


export type WorkSessionGroup<T> = { rootSessionId: string | null; title: string; items: T[]; unassigned: boolean };

/** Sessions are user conversation/control boundaries; work belongs to an authorized root session. */
export function workSessionGroups<
  T extends { sessionId: string; rootSessionId?: string },
  S extends { id: string; rootSessionId?: string; title?: string; adapter: string },
>(workItems: T[], sessions: S[]): WorkSessionGroup<T>[] {
  const roots = new Map(sessions.filter((session) => session.rootSessionId === session.id).map((session) => [session.id, session]));
  const grouped = new Map<string | null, T[]>();
  for (const work of workItems) {
    const rootId = work.rootSessionId ?? work.sessionId;
    const key = roots.has(rootId) ? rootId : null;
    grouped.set(key, [...(grouped.get(key) ?? []), work]);
  }
  return [...grouped].map(([rootSessionId, items]) => {
    const root = rootSessionId ? roots.get(rootSessionId) : undefined;
    return {
      rootSessionId,
      title: root ? root.title || root.adapter : "Unassigned",
      items,
      unassigned: rootSessionId === null,
    };
  });
}
export type BackState = { index: number; sessionId: string | null };

export function canNavigateBack({ index, sessionId }: BackState): boolean {
  return sessionId !== null || index > 0;
}

export type WorkAccordionDescriptor = { element: "details"; summary: string; expanded: boolean };

export function workAccordionDescriptor(title: string, count: number, expanded = false): WorkAccordionDescriptor {
  return { element: "details", summary: `${title} (${count})`, expanded };
}

export type DenseRowDescriptor = {
  element: "button";
  type: "button";
  interactiveControls: 1;
  statusText: string;
  pressed: boolean | undefined;
};

export function denseRowDescriptor(state: string, pressed?: boolean): DenseRowDescriptor {
  return {
    element: "button",
    type: "button",
    interactiveControls: 1,
    statusText: `Status: ${state === "stale" ? "Stale" : state}`,
    pressed,
  };
}

export type InboxRowDescriptor = {
  element: "li";
  children: readonly [
    { element: "action" },
    ...Array<{ element: "button"; type: "button"; label: "View session" }>
  ];
};

export function inboxRowDescriptor(hasSession: boolean): InboxRowDescriptor {
  return {
    element: "li",
    children: hasSession
      ? [{ element: "action" }, { element: "button", type: "button", label: "View session" }]
      : [{ element: "action" }],
  };
}
