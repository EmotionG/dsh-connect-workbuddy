/**
 * WorkBuddy 视频生成：纯逻辑层。
 *
 * 守三件事，与 image-gen.spec.ts 同一套思路：
 *  1. **模型筛选**只认产品配置里真实的 `tags`（含 text-to-video / image-to-video）。
 *  2. **请求体分支**照抄官方 CLI 的 `submitTask`：文生视频带 `aspect_ratio`、
 *     图生视频带 `image_url`、两者都带 `watermark:true` 与 `extra_parameters`。
 *  3. **解析段**——提交取 `data.id`、轮询取 `status` / 视频 URL / 实扣积分——
 *     以及失败分类（401/403 → AUTH、404 → NO_ROUTE、429 → RATE_LIMIT、其它 → UPSTREAM）。
 */
import { describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_SECONDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
  buildVideoBody,
  describeVideoFailure,
  parseVideoSubmission,
  parseVideoTask,
  pickVideoModel,
  resolveVideoParams,
  selectMediaModels,
  type WorkBuddyMediaModel,
} from '../src/video-gen.ts'

/** 国际区 `/v3/config` 的真实形状：`kling-video-v3` 同时带两个 video tag。 */
const globalModels = [
  { id: 'hy3', name: 'Hy3', tags: ['craft'] },
  { id: 'kling-video-v3', name: 'Kling Video v3', tags: ['text-to-video', 'image-to-video'] },
]

/**
 * 国内区（2026-10-25 实测，61 条里媒体条目只有这两条）：`kling-video-v3` 与
 * `minimax-video-h3` 各带 `text-to-video` + `image-to-video`。
 */
const cnModels = [
  { id: 'kling-video-v3', name: 'Kling Video v3', tags: ['text-to-video', 'image-to-video'] },
  { id: 'minimax-video-h3', name: 'Minimax Video h3', tags: ['text-to-video', 'image-to-video'] },
]

function mediaModel(id = 'kling-video-v3'): WorkBuddyMediaModel {
  return { id, name: id, tags: ['text-to-video', 'image-to-video'] }
}

describe('selectMediaModels（视频 tag）', () => {
  it('文生视频只挑带 text-to-video 的条目', () => {
    expect(selectMediaModels(cnModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3', 'minimax-video-h3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('图生视频只挑带 image-to-video 的条目', () => {
    expect(selectMediaModels(cnModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3', 'minimax-video-h3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('国际区 kling-video-v3 两个 video tag 都能选到（同一模型命中两次）', () => {
    expect(selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('非数组 / 缺 id 的条目不会让它崩', () => {
    expect(selectMediaModels(undefined, VIDEO_TAG_TEXT_TO_VIDEO)).toEqual([])
    expect(selectMediaModels([null, 42, 'x', { tags: ['text-to-video'] }], VIDEO_TAG_TEXT_TO_VIDEO)).toEqual([])
  })
})

describe('pickVideoModel', () => {
  it('点名一个存在的模型就用它', () => {
    const models = [mediaModel('a'), mediaModel('b')]
    expect(pickVideoModel(models, 'b', VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('b')
  })

  it('不点名就用目录里的第一个', () => {
    expect(pickVideoModel([mediaModel('first'), mediaModel('second')], undefined, VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('first')
  })

  it('国际区同一条目两个 tag 都能作默认', () => {
    const models = selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO)
    expect(pickVideoModel(models, undefined, VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('kling-video-v3')
    expect(pickVideoModel(models, undefined, VIDEO_TAG_IMAGE_TO_VIDEO).id).toBe('kling-video-v3')
  })

  it('点名一个不存在的模型直接报错，并列出可用的', () => {
    try {
      pickVideoModel([mediaModel('a'), mediaModel('b')], 'nope', VIDEO_TAG_TEXT_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkBuddyVideoError)
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
      expect((error as Error).message).toContain('nope')
      expect((error as Error).message).toContain('a, b')
    }
  })

  it('目录为空时报「该区没有视频模型」', () => {
    try {
      pickVideoModel([], undefined, VIDEO_TAG_TEXT_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
    }
  })

  it('拿文生视频模型去图生视频也会被拒（写错组）', () => {
    // kling-video-v3 两个 tag 都有，所以必须用只带一个 tag 的夹具才能复现：
    const models = [{ id: 'kling-video-v3', name: 'Kling', tags: [VIDEO_TAG_TEXT_TO_VIDEO] }]
    try {
      pickVideoModel(models, 'kling-video-v3', VIDEO_TAG_IMAGE_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
      expect((error as Error).message).toContain('图生视频')
    }
  })
})

describe('buildVideoBody', () => {
  it('文生视频带 aspect_ratio 与 watermark，negative_prompt 缺省空串', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: '一只猫在跑步',
    }, false)
    expect(body['prompt']).toBe('一只猫在跑步')
    expect(body['model']).toBe('kling-video-v3')
    expect(body['watermark']).toBe(true)
    expect(body['negative_prompt']).toBe('')
    expect(body['extra_parameters']).toEqual({
      resolution: undefined,
      enable_audio: true,
      aspect_ratio: DEFAULT_VIDEO_ASPECT_RATIO,
    })
    // 文生视频不带 image_url / last_image_url
    expect(body).not.toHaveProperty('image_url')
    expect(body).not.toHaveProperty('last_image_url')
  })

  it('图生视频带 image_url 且不上 aspect_ratio（比例由输入图决定）', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: '让这张图动起来',
      image: 'https://example.com/in.png',
    }, true)
    expect(body['image_url']).toBe('https://example.com/in.png')
    expect(body['extra_parameters']).toEqual({
      resolution: undefined,
      enable_audio: true,
    })
    expect((body['extra_parameters'] as Record<string, unknown>)).not.toHaveProperty('aspect_ratio')
  })

  it('图生视频支持 last_image_url（首尾帧）', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: 'p',
      lastImage: 'https://example.com/last.png',
    }, true)
    expect(body['last_image_url']).toBe('https://example.com/last.png')
    expect(body).not.toHaveProperty('image_url')
  })

  it('resolution / enable_audio / aspect_ratio 都被原样透传（信任已校验的值）', () => {
    const text = buildVideoBody({
      model: 'kling-video-v3',
      prompt: 'p',
      resolution: '1080p',
      aspectRatio: '9:16',
      enableAudio: false,
      seconds: 10,
    }, false)
    expect(text['seconds']).toBe(10)
    expect(text['extra_parameters']).toEqual({
      resolution: '1080p',
      enable_audio: false,
      aspect_ratio: '9:16',
    })
  })
})

describe('resolveVideoParams', () => {
  it('prompt 超 2500 字 → INVALID_ARGS', () => {
    expect(() => resolveVideoParams({ model: 'm', prompt: 'x'.repeat(2501) }))
      .toThrow(WorkBuddyVideoError)
    try {
      resolveVideoParams({ model: 'm', prompt: 'x'.repeat(2501) })
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
  })

  it('negative_prompt 超 2500 字 → INVALID_ARGS', () => {
    try {
      resolveVideoParams({ model: 'm', prompt: 'p', negativePrompt: 'x'.repeat(2501) })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
  })

  it('aspect_ratio 非法 → INVALID_ARGS（图生视频不校验）', () => {
    try {
      resolveVideoParams({ model: 'm', prompt: 'p', aspectRatio: '2:3' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
    // 合法值都能过
    for (const ar of VIDEO_ASPECT_RATIOS) {
      expect(resolveVideoParams({ model: 'm', prompt: 'p', aspectRatio: ar }).aspectRatio).toBe(ar)
    }
  })

  it('没有 videoGeneration 配置时透传用户时长，不盲拒', () => {
    // 拿不到 min/maxSeconds：给任意 seconds 都接受，避免把所有自定义时长判死。
    expect(resolveVideoParams({ model: 'm', prompt: 'p', seconds: 15 }).seconds).toBe(15)
    expect(resolveVideoParams({ model: 'm', prompt: 'p' }).seconds).toBe(DEFAULT_VIDEO_SECONDS)
  })

  it('有时长上限且越界 → INVALID_ARGS', () => {
    try {
      resolveVideoParams(
        { model: 'm', prompt: 'p', seconds: 60 },
        { minSeconds: 5, maxSeconds: 30, defaultSeconds: 5 },
      )
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
      expect((error as Error).message).toContain('5')
      expect((error as Error).message).toContain('30')
    }
  })

  it('有时长上限且在范围内 → 原数返回', () => {
    expect(resolveVideoParams({ model: 'm', prompt: 'p', seconds: 20 },
      { minSeconds: 5, maxSeconds: 30, defaultSeconds: 5 }).seconds).toBe(20)
  })

  it('分辨率不在模型集合里 → 回落默认并给告警', () => {
    const result = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '4k' },
      { resolutions: ['720p', '1080p'], defaultResolution: '1080p' },
    )
    expect(result.resolution).toBe('1080p')
    expect(result.warnings).toEqual(['resolution 4k 不被模型 m 支持；改用 1080p'])
  })

  it('分辨率在集合里 → 原样采纳', () => {
    const result = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '720p' },
      { resolutions: ['720p', '1080p'], defaultResolution: '1080p' },
    )
    expect(result.resolution).toBe('720p')
    expect(result.warnings).toEqual([])
  })

  it('图生视频时 aspectRatio 一定是 undefined（比例由输入图决定）', () => {
    const result = resolveVideoParams({ model: 'm', prompt: 'p', image: 'x', aspectRatio: '9:16' })
    expect(result.aspectRatio).toBeUndefined()
  })
})

describe('parseVideoSubmission', () => {
  it('成功取 data.id 作 taskId', () => {
    expect(parseVideoSubmission({ code: 0, data: { id: 'task-1' } }).taskId).toBe('task-1')
  })

  it('code 非 0 → UPSTREAM，并带 msg 与 request_id', () => {
    try {
      parseVideoSubmission({ code: 50001, msg: 'boom', request_id: 'r-9' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('UPSTREAM')
      expect((error as Error).message).toContain('50001')
      expect((error as Error).message).toContain('boom')
      expect((error as Error).message).toContain('r-9')
    }
  })

  it('无 data.id → EMPTY_RESULT', () => {
    try {
      parseVideoSubmission({ code: 0, data: {} })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('EMPTY_RESULT')
    }
  })
})

describe('parseVideoTask', () => {
  it('completed 取出视频 URL 列表与实扣积分', () => {
    const result = parseVideoTask({
      code: 0,
      data: {
        status: 'completed',
        data: [{ url: 'https://cos.example/a.mp4' }, { url: 'https://cos.example/b.mp4' }],
        usage: { credit: 12.5 },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.videos).toEqual(['https://cos.example/a.mp4', 'https://cos.example/b.mp4'])
    expect(result.credit).toBe(12.5)
  })

  it('completed 但空 data → 没有视频，按未完成处理（上层再判 EMPTY_RESULT）', () => {
    const result = parseVideoTask({ code: 0, data: { status: 'completed', data: [] } })
    expect(result.status).toBe('completed')
    expect(result.videos).toEqual([])
  })

  it('未知 status 当成未完成，继续轮询（不报错）', () => {
    // 上游若新增状态，旧插件不应误判成失败而浪费一次已花钱的任务。
    const result = parseVideoTask({ code: 0, data: { status: 'queued' } })
    expect(result.status).toBe('queued')
    expect(result.videos).toEqual([])
  })

  it('failed → 返回 failed 状态，视频为空（上层抛 TASK_FAILED）', () => {
    const result = parseVideoTask({ code: 0, data: { status: 'failed' } })
    expect(result.status).toBe('failed')
    expect(result.videos).toEqual([])
  })
})

describe('describeVideoFailure', () => {
  it('401/403 归为 AUTH 并提示重新登录', () => {
    for (const status of [401, 403]) {
      const error = describeVideoFailure(status, '')
      expect(error.code).toBe('AUTH')
      expect(error.message).toContain('重新登录')
    }
  })

  it('404 归为 NO_ROUTE', () => {
    expect(describeVideoFailure(404, '').code).toBe('NO_ROUTE')
    expect(describeVideoFailure(404, '').message).toContain('404')
  })

  it('429 归为 RATE_LIMIT', () => {
    expect(describeVideoFailure(429, '').code).toBe('RATE_LIMIT')
  })

  it('从 JSON 信封里抽出 code 与 msg', () => {
    const error = describeVideoFailure(500, JSON.stringify({ code: 50001, msg: 'boom' }))
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('50001')
    expect(error.message).toContain('boom')
  })

  it('非 JSON 的响应体截断后原样带上', () => {
    const error = describeVideoFailure(502, '<html>bad gateway</html>')
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('bad gateway')
  })
})
