# Planee Agent Hub Design System

## 1. Direction

The existing interface is a compact, dark, single-column personal control surface. This migration preserves that calm operational layout: pairing is a short blocking state, not a redesign or a new navigation model.

## 2. Color

| Token | Value | Use |
|---|---|---|
| `--color-page` | `#101826` | Page and input surface |
| `--color-surface` | `#1d2a40` | Buttons and message cards |
| `--color-border` | `#71809a` | Interactive borders |
| `--color-divider` | `#33425b` | Structural dividers |
| `--color-text` | `#eef3fa` | Primary text |
| `--color-muted` | `#b5c1d5` | Supporting text |
| `--color-focus` | `#74b9ff` dark / `#2f6eb2` light | Keyboard focus |
| `--color-live` | `#78dba9` | Connected state |
| `--color-warning` | `#ffd27a` | Degraded state |
| `--color-selected` | `#3267a8` | Active navigation |

## 3. Typography

- Primary: `system-ui, sans-serif`
- Heading: 19px (`h1`), 18px (`h2`), 16px body, 14px supporting text, 12px captions.
- Body copy never falls below 14px except compact navigation labels.

## 4. Spacing and Layout

- Base unit: 4px.
- The mobile-first shell uses a 16px panel and top-bar inset, a 48rem maximum width, and a fixed bottom navigation only after a credential is available.
- Pairing uses the same 16px panel rhythm and one-column form layout as prompt entry.

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

## 6. Motion and Interaction

- No decorative motion is introduced for this security flow.
- Buttons retain native active feedback; focus remains visibly outlined.
- Reduced-motion preference requires no additional override because no transition is added.

## 7. Depth and Surface

- Strategy: borders plus tonal surface shift.
- Buttons and message cards use `--color-surface`; structural boundaries use a one-pixel divider. No shadows are used.

## 8. Accessibility Constraints and Accepted Debt

- WCAG 2.2 AA target: visible focus, keyboard-complete pairing, explicit labels, status announcements, and a 44px minimum interactive target.
- Accepted debt: browser/PWA mode does not retain the device credential. This personal connector flow is Android-only and requires the Keystore-backed bridge.
