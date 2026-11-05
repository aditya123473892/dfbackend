import { NotFoundException } from '@nestjs/common';
import { LegalController, renderLegalPage } from './legal.controller';
import { LEGAL_CONTENT } from './legal-content';

describe('public legal pages', () => {
  it('renders every page with its title and the support address', () => {
    for (const [page, title] of [
      ['privacy', 'Privacy Policy'],
      ['terms', 'Terms of Use'],
      ['account-deletion', 'Account deletion'],
      ['support', 'Contact support'],
    ]) {
      const html = renderLegalPage(page)!;
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain(`mailto:${LEGAL_CONTENT.supportEmail}`);
    }
    expect(renderLegalPage('privacy')).toContain(LEGAL_CONTENT.privacy.sections[0].heading);
  });

  it('escapes text and rejects unknown pages', () => {
    expect(renderLegalPage('terms')).not.toMatch(/<script/i);
    expect(renderLegalPage('terms')).toContain('&quot;as is&quot;');
    expect(renderLegalPage('../secret')).toBeUndefined();
    const res: any = { setHeader: jest.fn(), type: jest.fn(() => res), send: jest.fn() };
    expect(() => new LegalController().page('nope', res)).toThrow(NotFoundException);
    new LegalController().page('privacy', res);
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=3600');
  });
});
