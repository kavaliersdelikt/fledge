import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { inBrowser, withBase } from 'vitepress';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (!inBrowser) return;
    // The home page is the hand-built landing page (landing/), not a VitePress page: load it for real.
    const home = withBase('/');
    router.onBeforeRouteChange = (to) => {
      const path = to.split('#')[0].split('?')[0];
      if (path === home || path === `${home}index.html` || path === `${home}index`) {
        window.location.href = to;
        return false;
      }
    };
  },
} satisfies Theme;
