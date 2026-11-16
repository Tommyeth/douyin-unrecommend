import { readFile, writeFile } from 'node:fs/promises';
const seconds = Number(process.argv[2] ?? 900);
const expressions = {
  300: '*/5 * * * *',
  900: '*/15 * * * *',
  1800: '*/30 * * * *',
  3600: '0 * * * *',
};
if (!expressions[seconds])
  throw Error('使用 npm run schedule:vercel -- 300|900|1800|3600；300 需要支持该频率的付费计划。');
const file = new URL('../vercel.json', import.meta.url);
const config = JSON.parse(await readFile(file, 'utf8'));
const schedule = config.schedules['douyin-hourly'];
if (!schedule) throw Error('未找到 douyin-hourly 调度，未修改文件。');
schedule.schedule = expressions[seconds];
schedule.jitter = seconds < 900 ? 1 : 15;
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
await writeFile(
  new URL('../src/vercel/schedule-policy.json', import.meta.url),
  JSON.stringify(
    { triggerSeconds: seconds, minimumInterval: seconds, intervalStep: seconds },
    null,
    2,
  ) + '\n',
);
console.log(
  `调度已设为每 ${seconds} 秒触发，请重新部署后在面板保存实际检查间隔。${seconds < 900 ? '此频率不适用于 Vercel Hobby；不会自动变更套餐。' : ''}`,
);
