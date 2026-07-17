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
