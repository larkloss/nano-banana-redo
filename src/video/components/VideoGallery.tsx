import type { GeneratedVideo } from '../../types'
import { getVeoModel } from '../../lib/veoModels'
import { downloadBlob } from '../../lib/imageUtils'

interface Props {
  videos: GeneratedVideo[]
  onRemove: (id: string) => void
  onClear: () => void
  isRunning: boolean
}

export function VideoGallery({ videos, onRemove, onClear, isRunning }: Props) {
  if (videos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
        Generated videos will appear here — download what you keep; results also expire from Google's servers
        after 2 days
      </div>
    )
  }

  const totalMb = videos.reduce((sum, v) => sum + v.blob.size, 0) / (1024 * 1024)

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {videos.length} video(s) this session · {totalMb.toFixed(1)} MB in memory — download to keep, closing
          the tab discards them
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={isRunning}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {videos.map((video, i) => (
          <VideoCard key={video.id} video={video} index={i} onRemove={() => onRemove(video.id)} />
        ))}
      </div>
    </div>
  )
}

function VideoCard({ video, index, onRemove }: { video: GeneratedVideo; index: number; onRemove: () => void }) {
  const model = getVeoModel(video.modelId)
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <video
        src={video.objectUrl}
        controls
        loop
        playsInline
        preload="metadata"
        className={`w-full bg-black ${video.aspectRatio === '9:16' ? 'aspect-[9/16] max-h-96' : 'aspect-video'}`}
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-[10px] text-zinc-500">
          {model.label} · {video.resolution} · {video.durationSeconds}s · {(video.blob.size / (1024 * 1024)).toFixed(1)} MB
        </span>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => downloadBlob(video.blob, makeVideoFilename(video, index))}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
          >
            ↓ Save
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-500 hover:bg-red-600/20 hover:text-red-400"
            title="Discard this video"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

function makeVideoFilename(video: GeneratedVideo, index: number): string {
  const ext = video.mimeType.includes('webm') ? 'webm' : 'mp4'
  const stamp = new Date(video.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const slug = getVeoModel(video.modelId).filenameSlug
  return `abigail-${slug}_${stamp}_${String(index + 1).padStart(2, '0')}.${ext}`
}
