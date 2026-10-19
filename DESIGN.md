# Design System: Trading Agent Mpu Gandring

## Visual atmosphere
Keep the warm wooden office, six pastel characters, keris identity and existing day/night themes. Operational UI is calm and compact. Keep financial facts easier to read than decorative motion.

## Palette and type
Use existing tokens: day panel #fffaf1, ink #3b2a1e, teal #3ea99f, danger #d0583f. Preserve existing night token mappings and role colors. Retain Nunito body, Fredoka headings and JetBrains Mono numbers. No new fonts or palette replacement.

## Controls and layout
Desk Ops separates automatic operation, manual tickets and maintenance. Auto state, running-cycle type, slots and source stay visible. All controls remain visible in compact labeled groups without disclosures. Keep Kill, Auto OFF and open-position Close directly accessible. The header uses bounded brand, balance and action columns, with visible action rows on smaller screens and no hamburger menu. Connection recovery appears only while disconnected.

Setup uses a stable viewport-bounded frame shared by every tab, including loading/error states. Header/navigation/footer stay in place. Only the content pane scrolls. Reserve the scrollbar gutter and use min-width/min-height zero on grid children. Preserve draft values on navigation. Field labels and plain helper text explain saved versus running values and PAPER versus venue funds.

## Motion
No shake, bounce, spring, scale or positional movement on modal/tab navigation or operational controls. Do not animate frame dimensions. Use restrained color/opacity feedback. Office animation remains local to the scene, interruptible and reduced-motion aware; it never delays an order.

## Accessibility
Visible labels, focus indicators, semantic groups and inline status/error feedback. Targets at least 44px. Responsive content fits at 375px and supports enlarged text. No hover-only instructions.

## Scope exceptions to design skills
The owner's stable settings request overrides perpetual micro-motion and asymmetric marketing layouts. Existing role colors/fonts override single-accent/font replacement suggestions. No Stitch screen generation, p5.js artwork, video render, new framework or branding artifact is needed.
