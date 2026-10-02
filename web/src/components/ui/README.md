# UI primitives

Thin wrappers around [Base UI](https://base-ui.com) components, originally generated from the official shadcn/ui **Base Nova** registry. Only the primitives the panel uses are kept: `button`, `dialog`, `alert-dialog`, `sheet`, `dropdown-menu`, and `tabs`.

Their colors come from the tokens in `app/globals.css` (`@theme inline`). Panel-specific styling is applied through class names such as `.modal`, `.drawer`, `.menu`, and `.ui-tabs-*` in the same file.

Upstream shadcn/ui is MIT licensed: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md
