/**
 * The video tool's MODEL RESOLUTION order: an explicit `model` argument, then the
 * model the user pinned in the card for that mode, then the first model of the
 * tag group.
 *
 * Why this needs its own suite: the pin is a SOFT constraint. It is written by a
 * picker the user may have used weeks ago, against a catalog that can change
 * under it (a plan swap, a region switch, a model retired upstream). A stale pin
 * must therefore fall back rather than fail — while an explicit argument, which
 * the CALLER wrote for THIS call, must still fail loudly when it names a model
 * that is not in the group. Those two rules point in opposite directions, so
 * they are pinned here side by side.
 */
import { describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
} from '../src/video-gen.ts'
import { createVideoTool, type VideoToolDeps } from '../src/video-tool.ts'

/** Both video tags — what each CN model declares today. */
const MEDIA_TAGS_FOR_VIDEO = [VIDEO_TAG_TEXT_TO_VIDEO, VIDEO_TAG_IMAGE_TO_VIDEO] as const

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: 'uid-1',
    source: 'dsh',
    filePath: '/tmp/auth.json',
  }
}

/** Two CN-style video models, both carrying both video tags (as measured). */
const MODELS = [
  { id: 'kling-video-v3', name: 'Kling v3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
  { id: 'minimax-video-h3', name: 'MiniMax H3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
]

function deps(overrides: Partial<VideoToolDeps> = {}): VideoToolDeps {
  return {
    resolveCredential: async () => credential(),
    listMediaModels: async () => MODELS,
    submitVideo: async () => ({ taskId: 'task-1', warnings: [] }),
    pollVideoTask: async () => ({ videos: ['https://cos.example/a.mp4'] }),
    downloadVideo: async () => '/tmp/a.mp4',
    logger: { warn: () => {} },
    ...overrides,
  }
}

/** Runs a text-to-video call and returns the model id it actually used. */
async function usedModel(overrides: Partial<VideoToolDeps>, model?: string): Promise<string> {
  const tool = createVideoTool(deps(overrides))
  const value = await tool.execute(
    model === undefined ? { prompt: '一只猫在弹钢琴' } : { prompt: '一只猫在弹钢琴', model },
    {},
  )
  return value['model'] as string
}

describe('video tool model resolution', () => {
  it('takes the group first model when nothing is pinned and nothing is passed', async () => {
    await expect(usedModel({})).resolves.toBe('kling-video-v3')
  })

  it('uses the pinned model when the call names none', async () => {
    const asked: string[] = []
    const model = await usedModel({
      preferredVideoModel: (_credential, tag) => {
        asked.push(tag)
        return 'minimax-video-h3'
      },
    })
    expect(model).toBe('minimax-video-h3')
    // The pin is per mode, so the tool must ask for the tag it is actually
    // about to use — asking for a fixed one would pick a text-to-video pin for an
    // image-to-video call.
    expect(asked).toEqual([VIDEO_TAG_TEXT_TO_VIDEO])
  })

  it('falls back to the group first model when the pin is no longer in the catalog', async () => {
    // The case that matters: the user pinned `minimax-video-h3` on a plan that
    // has since dropped it. Failing here would break a generation the user asked
    // for because of a preference they set earlier.
    const model = await usedModel({ preferredVideoModel: () => 'retired-video-9' })
    expect(model).toBe('kling-video-v3')
  })

  it('lets an explicit model win over the pin', async () => {
    const model = await usedModel({
      preferredVideoModel: () => 'kling-video-v3',
    }, 'minimax-video-h3')
    expect(model).toBe('minimax-video-h3')
  })

  it('does not even read the pin when the call named a model', async () => {
    let reads = 0
    await usedModel({
      preferredVideoModel: () => {
        reads += 1
        return 'kling-video-v3'
      },
    }, 'minimax-video-h3')
    expect(reads).toBe(0)
  })

  it('does not promise to clamp an out-of-range duration', async () => {
    // `resolveVideoParams` THROWS `INVALID_ARGS` outside the model's
    // minSeconds..maxSeconds. A description that said "clamped" would teach the
    // caller to send 30s and expect 5s back, then read the error as a bug.
    const tool = createVideoTool(deps())
    const seconds = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['seconds']!
    const description = seconds['description'] as string
    expect(description).toContain('报错')
    expect(description).not.toContain('夹回')
  })

  it('still fails loudly for an explicit model that is not in the group', async () => {
    // The other direction: this name came from THIS call, so a wrong one is a
    // caller error and must not be silently replaced by a different model.
    const tool = createVideoTool(deps({ preferredVideoModel: () => 'kling-video-v3' }))
    const failure = await tool.execute({ prompt: '一只猫', model: 'retired-video-9' }, {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
  })
})
