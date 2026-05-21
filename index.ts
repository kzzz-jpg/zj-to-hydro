import AdmZip from 'adm-zip';
import { promises as fsNative } from 'fs';
import {
    buildContent, Context, Handler, PERM,
    ProblemModel, Schema, ValidationError, yaml,
    Service
} from 'hydrooj';
import { htmlToOJMarkdown } from './src/zjHtmlToMarkdown';
import { STATUS } from '@hydrooj/common';
import { CopyInFile, runQueued } from '@hydrooj/hydrojudge/src/sandbox';
import checkers from '@hydrooj/hydrojudge/src/checkers';

// define ZJson Schema
const ZJsonSchema = Schema.object({
    title: Schema.string().required(),
    problemid: Schema.string().required(),
    author: Schema.string(),
    content: Schema.string(),
    theinput: Schema.string(),
    theoutput: Schema.string(),
    sampleinput: Schema.string(),
    sampleoutput: Schema.string(),
    hint: Schema.string(),
    keywords: Schema.any(),
    testfilelength: Schema.number().default(0),
    testinfiles: Schema.array(Schema.string()),
    testoutfiles: Schema.array(Schema.string()),
    timelimits: Schema.any(),
    memorylimit: Schema.number(),
    samplecode: Schema.string(),
    language: Schema.string(),
    specialjudge_code: Schema.string(),
    specialjudge_language: Schema.any(),
    judgemode: Schema.string(),
});

class ImportZerojudgeHandler extends Handler {
    static zjUrl?: string; // fix: ? added, camelCase
    static zjCheckerType ?: string;
    async processZJson(domainId: string, rawData: any) {
        let data;
        try {
            data = ZJsonSchema(rawData);
        } catch (e: unknown) {
            if (e instanceof ValidationError) throw e;
            else if (e instanceof Error) throw new ValidationError('file', null, `Invalid ZJSON content: ${e.message}`);
            else throw new ValidationError('file', null, `Invalid ZJSON content`);
        }
        const pidRegex = /^[a-zA-Z]\d{3}$/;
        if (!pidRegex.test(data.problemid)) {
            throw new ValidationError('problemid', null, `Invalid PID: ${data.problemid}. Must be one letter + 3 digits.`);
        }

        if (await ProblemModel.get(domainId, data.problemid)) {
            throw new ValidationError('problemid', null, `PID ${data.problemid} already exists.`);
        }

        const convertHtmlToMarkdown = async (html: string): Promise<string> => {
            if (!html) return '';
            console.log('\n\n\nConverting HTML to Markdown. Original HTML:', html);
            const result: string = htmlToOJMarkdown(html);
            console.log('\n\n\nConverted HTML to Markdown:', result || '');
            console.log('--- End of Conversion ---\n\n\n');
            return result || '';
        };

        let descriptionMarkdown = await convertHtmlToMarkdown(data.content);
        const authorBaseUrl = ImportZerojudgeHandler.zjUrl;
        if (data.author) {
            if (authorBaseUrl && authorBaseUrl.trim()) {
                const connector = authorBaseUrl.includes('?') ? '&account=' : '?account=';
                const cleanUrl = authorBaseUrl.replace(/\/+$/, '');
                const authorUrl = `${cleanUrl}${connector}${encodeURIComponent(data.author)}`;
                descriptionMarkdown = `**Author**: [${data.author}](${authorUrl})\n\n${descriptionMarkdown}`;
            } else {
                descriptionMarkdown = `**Author**: ${data.author}\n\n${descriptionMarkdown}`;
            }
        }

        // Build samples from testinfiles/testoutfiles (multiple examples as separate code blocks)
        const samples: string[][] = [];
        if (data.testinfiles && data.testoutfiles) {
            const count = Math.min(data.testinfiles.length, data.testoutfiles.length);
            for (let i = 0; i < count; i++) {
                const input = data.testinfiles[i] || '';
                const output = data.testoutfiles[i] || '';
                // Format each sample as separate code blocks
                samples.push([`\`\`\`\n${input}\n\`\`\``, `\`\`\`\n${output}\n\`\`\``]);
            }
        } else if (data.sampleinput && data.sampleoutput) {
            // Fallback to sampleinput/sampleoutput if testinfiles/testoutfiles not available
            samples.push([`\`\`\`\n${data.sampleinput}\n\`\`\``, `\`\`\`\n${data.sampleoutput}\n\`\`\``]);
        }

        const contentMarkdown = buildContent({
            description: descriptionMarkdown,
            input: await convertHtmlToMarkdown(data.theinput),
            output: await convertHtmlToMarkdown(data.theoutput),
            samples,
            hint: await convertHtmlToMarkdown(data.hint),
        }, 'markdown');
        const tags = data.keywords ? (typeof data.keywords === 'string' ? JSON.parse(data.keywords) : data.keywords) : [];
        const pid = await ProblemModel.add(
            domainId, data.problemid, data.title, contentMarkdown,
            this.user._id, tags,
        );
        const tasks = [];
        const default_tl = Array.isArray(data.timelimits) ? Math.max(...data.timelimits) : data.timelimits;
        const config = {
            type: 'default',
            time: `${default_tl}s`,
            memory: `${data.memorylimit}mb`,
            subtasks: [] as any[],
        };
        if (!data.timelimits) config.time = '3s';
        if (!data.memorylimit) config.memory = '100mb';
        for (let i = 0; i < data.testfilelength; i++) {
            const inName = `${i + 1}.in`;
            const outName = `${i + 1}.out`;
            const inContent = data.testinfiles && data.testinfiles[i] ? data.testinfiles[i] : "";
            const outContent = data.testoutfiles && data.testoutfiles[i] ? data.testoutfiles[i] : "";
            const score = data.scores[i] ?? 100 / data.testfilelength;
            const tl = data.timelimits[i] ?? default_tl;
            tasks.push(ProblemModel.addTestdata(domainId, pid, inName, Buffer.from(inContent || '')));
            tasks.push(ProblemModel.addTestdata(domainId, pid, outName, Buffer.from(outContent || '')));
            config.subtasks.push({
                time: `${tl}s`,
                score,
                if: [],
                id: i + 1,
                type: 'sum',
                cases: [{ input: inName, output: outName }],
            });
        }
        if (data.specialjudge_code) {
            const spj_code = data.specialjudge_code;
            const lang_suffix = data.specialjudge_language.suffix ?? '';
            const checker_filename = `checker.${lang_suffix}`;
            tasks.push(ProblemModel.addTestdata(domainId, pid, checker_filename, Buffer.from(spj_code ?? '')));
            if (data.judgemode === 'Special' && this.zjCheckerType) {
                config.checker_type = this.zjCheckerType;
                config.checker = {
                    file: checker_filename,
                    lang: 'auto',
                };
            }
        }
        if (data.samplecode) {
            const sample_code = data.samplecode;
            let suffix;
            switch (data.language) {
                case 'C':
                    suffix = '.c';
                    break;
                case 'CPP':
                    suffix = '.cpp';
                    break;
                case 'JAVA':
                    suffix = '.java';
                    break;
                case 'PYTHON':
                    suffix = '.py';
                    break;
                case 'PASCAL':
                    suffix = '.pas';
                    break;
                default:
                    suffix = '';
            }
            tasks.push(ProblemModel.addTestdata(domainId, pid, `sample_code${suffix}`, Buffer.from(sample_code)));
        }
        tasks.push(ProblemModel.addTestdata(domainId, pid, 'config.yaml', Buffer.from(yaml.dump(config))));
        tasks.push(tasks.push(ProblemModel.edit(domainId, pid, { hidden: true })));
        await Promise.all(tasks);
    }

    async fromFile(domainId: string, filePath: string) {
        const buf = await fsNative.readFile(filePath);
        console.log('DEBUG: File head bytes:', buf[0], buf[1], buf[2], buf[3]);
        console.log('DEBUG: Is Buffer?', Buffer.isBuffer(buf));
        const isZip = buf[0] === 0x50 && buf[1] === 0x4b;

        if (isZip) {
            console.log('DEBUG: ZIP logic triggered');
            try {
                const zip = new AdmZip(buf);
                const zipEntries = zip.getEntries();
                const jsonEntries = zipEntries.filter((entry: AdmZip.IZipEntry) =>
                    entry.entryName.toLowerCase().endsWith('.zjson')
                );

                if (jsonEntries.length === 0) throw new ValidationError('file', null, "Can't find any .zjson files in the ZIP");

                for (const jsonEntry of jsonEntries) {
                    const rawData = JSON.parse(jsonEntry.getData().toString('utf8'));
                    try {
                        await this.processZJson(domainId, rawData);
                    } catch (e) {
                        console.error(`Error processing ${jsonEntry.entryName}:`, e);
                    }
                }
            } catch (e: unknown) {
                if (e instanceof ValidationError) {
                    throw e;
                } else if (e instanceof Error) {
                    throw new ValidationError('file', null, `ZJSON 解析失敗: ${e.message}`);
                } else {
                    throw new ValidationError('file', null, `ZJSON 解析失敗`);
                }
            }
        } else {
            console.log('DEBUG: ZJSON logic triggered');
            try {
                const rawData = JSON.parse(buf.toString('utf8'));
                await this.processZJson(domainId, rawData);
            } catch (e: unknown) {
                if (e instanceof ValidationError) {
                    throw e;
                } else if (e instanceof Error) {
                    throw new ValidationError('file', null, `ZJSON 解析失敗: ${e.message}`);
                } else {
                    throw new ValidationError('file', null, `ZJSON 解析失敗`);
                }
            }
        }
    }

    async get() {
        this.response.body = { type: 'Zerojudge (.zjson/.zip)' };
        this.response.template = 'problem_import.html';
    }

    async post({ domainId }: { domainId: string }) {
        console.log('Post started');
        const file = this.request.files.file;
        if (!file) throw new ValidationError('file');
        console.log('File path:', file.filepath);
        await this.fromFile(domainId, file.filepath);
        console.log('fromFile finished');
        this.response.redirect = this.url('problem_main', { domainId });
    }
}

async function zerojudgeChecker(config) {
    const { stdout, status, code } = await runQueued(`${config.execute} input answer user_out user_code`, {
        copyIn: {
            input: config.input,
            answer: config.output,
            user_out: config.user_stdout,
            user_code: config.code,
            ...config.copyIn,
        },
        env: config.env,
    });
    if (status !== STATUS.STATUS_ACCEPTED) {
        return {
            status: STATUS.STATUS_SYSTEM_ERROR,
            score: 0,
            message: 'Checker Error',
        };
    }
    if (code !== 0) {
        return {
            status: STATUS.STATUS_SYSTEM_ERROR,
            score: 0,
            message: 'Checker returned non-zero exit code.',
        };
    }
    let judge_result = STATUS.STATUS_SYSTEM_ERROR;
    let message = '';
    for (const line of stdout.split('\n')) {
        if (line.startsWith('$JUDGE_RESULT=')) {
            const result = line.slice(14);
            if (result === 'AC') {
                judge_result = STATUS.STATUS_ACCEPTED;
            } else if (result === 'WA' || result === 'OLE') {
                judge_result = STATUS.STATUS_WRONG_ANSWER;
            }
            break;
        } else if (config.detail === 'full' && line.startsWith('$MESSAGE=')) {
            message = line.slice(9);
        }
    }
    return {
        status: judge_result,
        score: judge_result === STATUS.STATUS_ACCEPTED ? config.score : 0,
        message: judge_result === STATUS.STATUS_SYSTEM_ERROR ? 'Invalid judge result returned from the checker.' : '',
    };
}

export default class ImportJsonService extends Service {
    static Config = Schema.object({
    ZjBaseUrl: Schema.string().description('Author Statistic Base URL').default(""),
    zjCheckerType: Schema.string().description('Zerojudge Checker Type Name').default("qduoj"),
    });
    constructor(ctx: Context, config: ReturnType<typeof ImportJsonService.Config>) {
        super(ctx, 'import-json-service');
        ctx.Route('problem_import_json', '/problem/import/json', ImportZerojudgeHandler, PERM.PERM_CREATE_PROBLEM);
        ctx.injectUI('ProblemAdd', 'problem_import_json', { icon: 'copy', text: 'From JSON/ZIP Export' });
        ImportZerojudgeHandler.zjUrl = config.ZjBaseUrl;
        ImportZerojudgeHandler.zjCheckerType = config.zjCheckerType;
        if (config.zjCheckerType) {
            checkers[config.zjCheckerType] = zerojudgeChecker;
        }
        ctx.i18n.load('zh_TW', {
            [config.zjCheckerType]: 'ZeroJudge',
            'From JSON/ZIP Export': '從 JSON/ZIP 導入 (ZJSON)',
            'Author Statistic Base URL': '作者統計頁面基準網址',
            'Example: https://dandanjudge.fdhs.tyc.edu.tw/UserStatistic': '例如: https://dandanjudge.fdhs.tyc.edu.tw/UserStatistic (留空則不嵌入連結)',
        });
    }
}





