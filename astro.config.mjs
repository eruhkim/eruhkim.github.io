// @ts-check
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://eruhkim.github.io',
	trailingSlash: 'always',
	integrations: [mdx(), sitemap()],
	markdown: {
		shikiConfig: {
			theme: 'github-light',
			wrap: false,
		},
	},
});
