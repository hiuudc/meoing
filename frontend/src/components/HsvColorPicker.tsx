import { hexToHsv, hsvToHex, saturationValueFromPointer } from "../theme";

interface HsvColorPickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function HsvColorPicker({ value, onChange }: HsvColorPickerProps) {
  const activeHsv = hexToHsv(value);

  function updatePicker(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const { s, v } = saturationValueFromPointer(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    );
    onChange(hsvToHex({ ...activeHsv, s, v }));
  }

  function updatePickerFromKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const increment = event.shiftKey ? 10 : 2;
    const next = { ...activeHsv };
    if (event.key === "ArrowLeft") next.s -= increment;
    else if (event.key === "ArrowRight") next.s += increment;
    else if (event.key === "ArrowDown") next.v -= increment;
    else if (event.key === "ArrowUp") next.v += increment;
    else return;
    event.preventDefault();
    onChange(hsvToHex(next));
  }

  return (
    <>
      <div
        className="interactive-color-picker"
        style={{
          "--picker-hue": `hsl(${activeHsv.h}, 100%, 50%)`,
          "--picker-x": `${activeHsv.s}%`,
          "--picker-y": `${100 - activeHsv.v}%`,
        } as React.CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label="Color saturation and brightness"
        aria-valuetext={`${activeHsv.s}% saturation, ${activeHsv.v}% brightness`}
        onKeyDown={updatePickerFromKeyboard}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updatePicker(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePicker(event);
        }}
      >
        <span />
      </div>
      <input
        className="drawer-hue-slider"
        type="range"
        min="0"
        max="359"
        value={activeHsv.h}
        onChange={(event) => onChange(hsvToHex({ ...activeHsv, h: Number(event.target.value) }))}
        aria-label="Hue"
      />
    </>
  );
}
