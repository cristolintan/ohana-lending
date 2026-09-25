## Lesson: Don't size inputCls fields with a second width utility

- **What went wrong:** `${inputCls} w-28 shrink-0` in a flex row rendered 100% wide; the neighbouring name input collapsed to 30px, so members' names couldn't be entered.
- **Root cause:** `inputCls` already contains `w-full`; Tailwind emits `w-full` after `w-28`, so it wins regardless of class order in the string.
- **New rule:** Lay out rows of `inputCls` fields with a CSS grid (column widths on the container), never by adding `w-*` to the input. Render new sheets at 360px (headless Chrome) before shipping.

## Lesson: Never let a library replace DOM nodes React owns

- **What went wrong:** Logging a Pass (or any payment clearing an overdue installment) blanked the app; reload fixed it.
- **Root cause:** `lucide.createIcons()` swaps React's `<i>` for an `<svg>`. When React later removes or inserts next to that `<i>`, the DOM call throws and React unmounts the whole tree.
- **New rule:** Third-party DOM rewriting must happen *inside* React-owned elements (see `paintIcons`). When a state change toggles UI, test the transition in the real app (headless Chrome harness), not just the end state after reload.
