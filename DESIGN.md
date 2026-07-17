# Planee Agent Hub Design System

## 1. Direction

The authenticated interface is a calm, Linear-inspired single-column control surface. Inbox, Sessions, and Archive use dense semantic rows; active work is disclosed beneath its owning human-root session instead of appearing as a peer navigation surface.

## 2. Color

| Token | Value | Use |
|---|---|---|
| `--color-page` | `#111216` | App shell and input background |
| `--color-surface` | `#181a20` | Action and control surfaces |
| `--color-elevated` | `#20232b` | Badges and messages |
| `--color-border` | `#2a2d36` | Restrained row separators |
| `--color-text` | `#f2f3f5` | Primary text |
| `--color-muted` | `#9399a8` | State, time, and metadata |
| `--color-focus` | `#8da2fb` | Keyboard focus |
| `--color-live` | `#6dc89b` | Connected state |
| `--color-warning` | `#d7b46a` | Degraded state |
| `--color-selected` | `#242b46` | Active navigation |

## 3. Typography

- Primary: Inter, with `ui-sans-serif` and `system-ui` fallbacks.
- Headings use 600 weight and tight tracking; row titles use 500 weight; supporting metadata uses 11–12px at high contrast.
- State and time are subordinate to the session/work title. Section labels are compact uppercase labels; user-facing page headings retain natural case.

## 4. Spacing and Layout

- Base unit: 4px.
- The mobile-first shell uses a 16px panel and top-bar inset, a 48rem maximum width, and persistent bottom navigation after a credential is available.
- The central panel is the only scrolling region. Top bar and bottom navigation remain stable, with top and bottom safe-area insets.
- Dense rows are at least 58px high and separated by one-pixel rules rather than individual borders or cards.

## 5. Components

### Button

- States: default, disabled, visible keyboard focus, active navigation.
- Minimum height: 44px.
- Accessibility: native button semantics and visible focus ring.

### Form field

- Structure: native label plus input or textarea.
- States: default, focus, disabled, required validation error.
- Accessibility: labels are programmatically associated; pairing instructions are announced with `aria-live`.

### Pairing screen

- Structure: heading, concise instructions, pairing-code field, device-name field, primary submit action, status message.
- States: ready, submitting, invalid/expired code, network error.
- Accessibility: the initial pairing-code field receives focus and error/status text is announced.

### Dense row

- Used for Sessions and Archive navigation.
- A human-root Session is a native disclosure parent. Its active work appears only when expanded, indented beneath the parent; terminal work is not fetched for this surface.
- Internal executions never appear as peer rows. `internalCount`, `actionableCount`, and `failureCount` remain compact badges on the human-root row.
- Session content keeps explicit Open and Archive actions. Long press and deliberate left swipe may request Archive, but both route through the same explicit Cancel/Archive confirmation.
- The row retains a minimum 44px target and visible keyboard focus.

### Inbox action surface

- Inbox keeps the action card supplied by the HITL renderer. A session navigation control is a sibling of that card, never nested inside it.
- Internal-origin actions resolve navigation through `rootSessionId`, falling back to `sessionId` during staged API rollout.

### Internal activity disclosure

- Session detail conditionally shows a native, collapsed `details` disclosure when `internalCount` is non-zero.
- Opening it lazily requests the capped, paginated summary endpoint. Loading, empty, and error states are explicit.
- Drill-down items are summaries, not interactive peer sessions.

## 6. Motion and Interaction

- Android Back consumes in-app detail/tab history first. At the root it opens an explicit Cancel/Exit confirmation instead of immediately leaving the app.
- Long press and left swipe are optional accelerators for archive confirmation; keyboard and screen-reader users retain the explicit Archive action.
- Buttons retain native active feedback; focus remains visibly outlined.
- Reduced-motion preference requires no additional override because no decorative transition is added.

## 7. Depth and Surface

- Strategy: separators and small tonal shifts, with surfaces reserved for controls, Inbox actions, and messages.
- Dense navigation rows have no per-row border, radius, shadow, or card background. Structural boundaries use a one-pixel divider.

## 8. Accessibility Constraints and Accepted Debt

- WCAG 2.2 AA target: visible focus, keyboard-complete pairing, explicit labels, status announcements, and a 44px minimum interactive target.
- Accepted debt: browser/PWA mode does not retain the device credential. This personal connector flow is Android-only and requires the Keystore-backed bridge.
- Session hierarchy wire fields are additive and optional during staged integration: `rootSessionId`, `internalCount`, `actionableCount`, `failureCount`, and `lastActivityAt`. Missing values preserve legacy navigation and omit rollup UI.
- Human-root sessions are the only listable Sessions/Archive peers. Active work resolves through `rootSessionId` with `sessionId` fallback and appears only beneath that parent; internal execution summaries remain available only through rollups and explicit drill-down.
