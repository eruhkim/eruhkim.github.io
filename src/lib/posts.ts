import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

/** Published posts, newest first. Drafts show up only in `astro dev`. */
export async function getPosts(): Promise<Post[]> {
	const posts = await getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function postUrl(post: Post) {
	return `/posts/${post.id}/`;
}

export function tagUrl(tag: string) {
	return `/tags/${encodeURIComponent(tag)}/`;
}
