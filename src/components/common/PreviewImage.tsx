import { useRef, type ImgHTMLAttributes } from 'react'

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  // The picture itself
  full: string
  // A reduced copy to show in its place, when there is one
  small?: string
}

// A picture shown from a reduced copy where it is shown small (a tile, a
// gallery card: a 4K picture decoded for each of them made the page stall
// and held a great deal of memory). Whatever takes a picture out of the page
// — a drag to the desktop, "Save image as", "Copy image" — must still take
// the picture itself, so that is put in the moment a button goes down on it,
// before any of those can start. The copy comes back once it was only a
// click, or the drag is over.
export function PreviewImage({ full, small, ...rest }: Props) {
  const picture = useRef<HTMLImageElement>(null)
  const show = (url: string | undefined) => {
    const img = picture.current
    if (img && small && url && img.getAttribute('src') !== url) img.src = url
  }
  const showItself = () => show(full)
  const showCopy = () => show(small)
  return (
    <img
      {...rest}
      ref={picture}
      src={small ?? full}
      // (where the picture itself is, for the checks in tools/e2e)
      data-full={full}
      onPointerDown={showItself}
      onContextMenu={showItself}
      onDragStart={(e) => {
        showItself()
        // A drag begun in the instant before the picture itself has loaded
        // would carry the copy: it does not start (the next one will)
        const img = e.currentTarget
        if (small && !(img.complete && img.naturalWidth > 0 && img.getAttribute('src') === full)) e.preventDefault()
      }}
      onDragEnd={showCopy}
      onClick={showCopy}
    />
  )
}
