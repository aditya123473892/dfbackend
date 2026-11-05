import { Controller, Get, Module, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { LEGAL_CONTENT } from './legal-content';

type Section = { heading: string; body?: readonly string[]; bullets?: readonly string[] };
type Doc = { title: string; updated: string; intro: readonly string[]; sections: readonly Section[] };

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Turns the support address inside the legal text into a mail link. */
const linkify = (value: string) =>
  escape(value).replaceAll(LEGAL_CONTENT.supportEmail, `<a href="mailto:${LEGAL_CONTENT.supportEmail}">${LEGAL_CONTENT.supportEmail}</a>`);

const PAGES = [
  ['privacy', 'Privacy Policy'],
  ['terms', 'Terms of Use'],
  ['account-deletion', 'Account deletion'],
  ['support', 'Contact support'],
] as const;

function layout(title: string, body: string) {
  const nav = PAGES.map(([slug, label]) => `<a href="./${slug}">${label}</a>`).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · DARKFANTASY</title><meta name="robots" content="index,follow">
<style>
:root{color-scheme:light dark;--bg:#fbf3f6;--fg:#1d1724;--muted:#5d5466;--accent:#c2416f}
@media (prefers-color-scheme:dark){:root{--bg:#181322;--fg:#f3edf6;--muted:#b5abbd;--accent:#f36f9b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:32px;margin:8px 0}h2{font-size:20px;margin:28px 0 8px}p,li{color:var(--muted)}
a{color:var(--accent)}nav{font-size:14px;margin-bottom:24px}.brand{font-weight:700;letter-spacing:.08em}
.updated{font-size:14px}
</style></head><body><main><div class="brand">DARKFANTASY · 18+</div><nav>${nav}</nav>${body}</main></body></html>`;
}

function renderDoc(doc: Doc) {
  const sections = doc.sections
    .map(
      (section) =>
        `<h2>${escape(section.heading)}</h2>${(section.body ?? []).map((p) => `<p>${linkify(p)}</p>`).join('')}${
          section.bullets?.length ? `<ul>${section.bullets.map((item) => `<li>${linkify(item)}</li>`).join('')}</ul>` : ''
        }`,
    )
    .join('');
  return layout(
    doc.title,
    `<h1>${escape(doc.title)}</h1><p class="updated">Last updated ${escape(doc.updated)}</p>${doc.intro
      .map((p) => `<p>${linkify(p)}</p>`)
      .join('')}${sections}`,
  );
}

function renderSupport() {
  const email = LEGAL_CONTENT.supportEmail;
  return layout(
    'Contact support',
    `<h1>Contact support</h1>
<p>Email <a href="mailto:${email}">${email}</a>. Our team usually replies within 2 business days.</p>
<p>In the app you can also open Settings › Help › Contact support, which fills in your app version and account ID for us.</p>
<p>Never share your password or verification codes with anyone, including us. If you or someone else is in immediate danger, contact your local emergency services now.</p>`,
  );
}

export function renderLegalPage(page: string): string | undefined {
  if (page === 'privacy') return renderDoc(LEGAL_CONTENT.privacy);
  if (page === 'terms') return renderDoc(LEGAL_CONTENT.terms);
  if (page === 'account-deletion') return renderDoc(LEGAL_CONTENT.deletion);
  if (page === 'support') return renderSupport();
  return undefined;
}

/**
 * Public pages for the store listings: /api/legal/privacy, /terms, /account-deletion, /support.
 * The text is generated from the mobile app so the app and the web always say the same thing.
 */
@Controller('legal')
export class LegalController {
  @Get(':page')
  page(@Param('page') page: string, @Res() res: Response) {
    const html = renderLegalPage(page);
    if (!html) throw new NotFoundException('Page not found');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('html').send(html);
  }
}

@Module({ controllers: [LegalController] })
export class LegalModule {}
