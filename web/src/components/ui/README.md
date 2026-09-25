# UI primitives

The sidebar primitives use the official shadcn/ui **Base UI** implementation, Base Nova style, retrieved from the shadcn registry on 2026-09-25.

Reference: https://ui.shadcn.com/docs/components/base/sidebar

Registry: https://ui.shadcn.com/r/styles/base-nova/sidebar.json

Sidebar 07 was added from the official block registry. The app keeps its `TeamSwitcher`, `NavMain`, `NavProjects`, `NavUser`, and `SidebarRail` composition in `src/components/app-sidebar.tsx` and the adjacent navigation components. Sample data is replaced with Fledge account details, routes, and shortcuts. The black theme is defined in `app/globals.css`.

Upstream shadcn/ui is MIT licensed: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md
