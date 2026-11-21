await import('../src/link-utils.js');

const { extractHttpUrls } = globalThis.ClipCargoLinkUtils;

const xhs = extractHttpUrls('周末咖啡探店 https://www.xiaohongshu.com/explore/abc123?xsec_token=ABc%2F123&xsec_source=pc_search 复制这段文字，打开小红书查看。');
if (xhs.length !== 1) throw new Error('Expected one Xiaohongshu URL');
if (!xhs[0].includes('xsec_token=ABc%2F123')) throw new Error('Xiaohongshu access token was not preserved');
if (xhs[0].endsWith('。')) throw new Error('Trailing Chinese punctuation was not removed');

const multiple = extractHttpUrls('TikTok https://vm.tiktok.com/a1/, 备用 https://example.com/video?id=2。');
if (multiple.length !== 2) throw new Error('Expected two URLs from one share line');
if (multiple[0] !== 'https://vm.tiktok.com/a1/') throw new Error('Trailing ASCII punctuation was not removed');
if (extractHttpUrls('只有文案，没有链接').length !== 0) throw new Error('Text without a URL must not create a candidate');

console.log(JSON.stringify({ xhsTokenPreserved: true, multipleLinks: multiple.length }));
