import fs from 'fs';
import path from 'path';

import type { MetadataRoute } from 'next';

import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = siteUrl();

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, priority: 1.0, changeFrequency: 'weekly' },
    { url: `${baseUrl}/pricing`, priority: 0.9, changeFrequency: 'weekly' },
    {
      url: `${baseUrl}/kalkulator-oszczednosci`,
      priority: 0.8,
      changeFrequency: 'monthly',
    },
    { url: `${baseUrl}/blog`, priority: 0.8, changeFrequency: 'weekly' },
    // /vs/* wyłączone 15.10.2026 (app/(marketing)/vs/layout.tsx) — wracają
    // do mapy razem z flagą COMPARISON_PAGES_PUBLISHED.
    { url: `${baseUrl}/kontakt`, priority: 0.5, changeFrequency: 'yearly' },
    { url: `${baseUrl}/legal/regulamin`, priority: 0.3, changeFrequency: 'yearly' },
    {
      url: `${baseUrl}/legal/polityka-prywatnosci`,
      priority: 0.3,
      changeFrequency: 'yearly',
    },
    { url: `${baseUrl}/legal/rodo`, priority: 0.3, changeFrequency: 'yearly' },
    { url: `${baseUrl}/legal/umowa-powierzenia`, priority: 0.3, changeFrequency: 'yearly' },
    { url: `${baseUrl}/legal/cookies`, priority: 0.3, changeFrequency: 'yearly' },
    { url: `${baseUrl}/legal/podprocesorzy`, priority: 0.2, changeFrequency: 'monthly' },
  ];

  const blogDir = path.join(process.cwd(), 'content/blog');
  const blogPages: MetadataRoute.Sitemap = fs.existsSync(blogDir)
    ? fs
        .readdirSync(blogDir)
        .filter((f) => f.endsWith('.mdx'))
        .map((f) => ({
          url: `${baseUrl}/blog/${f.replace(/\.mdx$/, '')}`,
          priority: 0.7,
          changeFrequency: 'monthly' as const,
        }))
    : [];

  return [...staticPages, ...blogPages];
}
