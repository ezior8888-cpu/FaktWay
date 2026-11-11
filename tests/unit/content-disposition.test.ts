import { describe, expect, it } from 'vitest';

import { attachmentDisposition, filenameFromDisposition } from '@/lib/http/content-disposition';

describe('attachmentDisposition', () => {
  it('polskie litery: zapas ASCII i pełna nazwa w filename*', () => {
    const h = attachmentDisposition('Faktura_FV_Łódź_śćżź_1.pdf');
    expect(h).toContain('filename="Faktura_FV_Lodz_sczz_1.pdf"');
    expect(h).toContain("filename*=UTF-8''Faktura_FV_%C5%81%C3%B3d%C5%BA_%C5%9B%C4%87%C5%BC%C5%BA_1.pdf");
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true);
  });

  it('cudzysłów i ukośnik wsteczny zamieniane na _ w zapasie', () => {
    const h = attachmentDisposition('a"b\\c.pdf');
    expect(h).toContain('filename="a_b_c.pdf"');
    expect(h).toContain("filename*=UTF-8''a%22b%5Cc.pdf");
  });

  it('sama nazwa ASCII bez zmian w filename="..."', () => {
    expect(attachmentDisposition('Faktura_FV_1.pdf')).toContain('filename="Faktura_FV_1.pdf";');
  });
});

describe('filenameFromDisposition', () => {
  it('czyta filename* przed filename', () => {
    expect(filenameFromDisposition(attachmentDisposition('Faktura_FV_Ł_1.pdf'), 'x.pdf')).toBe('Faktura_FV_Ł_1.pdf');
  });
  it('czyta starą postać filename="..."', () => {
    expect(filenameFromDisposition('attachment; filename="A.pdf"', 'x.pdf')).toBe('A.pdf');
  });
  it('zły ciąg procentowy: wraca do filename', () => {
    expect(filenameFromDisposition(`attachment; filename="A.pdf"; filename*=UTF-8''%E0%A4%A`, 'x.pdf')).toBe('A.pdf');
  });
  it('brak nagłówka: wartość zastępcza', () => {
    expect(filenameFromDisposition(null, 'x.pdf')).toBe('x.pdf');
    expect(filenameFromDisposition('', 'x.pdf')).toBe('x.pdf');
  });
});
