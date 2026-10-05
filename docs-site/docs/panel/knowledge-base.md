---
title: Knowledge base
---

# Knowledge base

Agents with `support.articles` can open **Help desk → Knowledge base** to create, preview, edit and delete Markdown articles. Use a stable lowercase URL slug, a title and a category.

Visibility can be Draft, Customers or Public. Drafts are visible to agents. Customer articles require sign-in. Public articles also need **Publish public articles** enabled in Desk settings; they are then available without sign-in at `/help`.

![A published article](/screenshots/kb-article.webp){.screenshot}

The help centre shows popular articles and searches their titles and content. New tickets suggest matching articles as the customer writes the subject. Agents can insert article links into replies. Customers can vote once per article. Reports collect aggregate search and no-result counts without attaching a user identity to a search.

Markdown uses the panel's safe renderer. Raw HTML does not execute. Keep secrets and customer-specific instructions out of articles, particularly public ones. See [support privacy](/security/support).
