package main

// Braille dot area chart — renders commit activity sparklines.
//
// Each braille character is a 2×4 dot grid (2 wide, 4 tall).
// We fill dots from bottom up to represent values, giving an
// area-chart effect similar to the flowstate commits widget.

// Braille dot positions (Unicode offset from U+2800):
//
//	dot1 (0x01)  dot4 (0x08)
//	dot2 (0x02)  dot5 (0x10)
//	dot3 (0x04)  dot6 (0x20)
//	dot7 (0x40)  dot8 (0x80)
var brailleDots = [4][2]rune{
	{0x40, 0x80}, // row 3 (bottom)
	{0x04, 0x20}, // row 2
	{0x02, 0x10}, // row 1
	{0x01, 0x08}, // row 0 (top)
}

// Sparkline renders a compact single-row braille area chart.
// Each character column represents 2 data points.
// Values are normalized to 0–4 (braille height).
func Sparkline(data []int, width int) string {
	if len(data) == 0 {
		return ""
	}

	// Find peak for normalization
	peak := 0
	for _, v := range data {
		if v > peak {
			peak = v
		}
	}
	if peak == 0 {
		// No activity — render flat baseline
		result := make([]rune, width)
		for i := range result {
			result[i] = '\u2800' // empty braille
		}
		return string(result)
	}

	// Resample data to fit width (each char = 2 columns)
	cols := width * 2
	resampled := resample(data, cols)

	// Normalize to 0–4 (4 dot rows)
	heights := make([]int, cols)
	for i, v := range resampled {
		// Scale to 1–4 for non-zero, 0 for zero
		if v > 0 {
			h := (v * 3 / peak) + 1 // 1–4
			if h > 4 {
				h = 4
			}
			heights[i] = h
		}
	}

	// Build braille characters (pair columns into chars)
	result := make([]rune, width)
	for i := 0; i < width; i++ {
		var pattern rune = 0x2800
		li := i * 2     // left column index
		ri := i*2 + 1   // right column index

		lh := 0
		if li < len(heights) {
			lh = heights[li]
		}
		rh := 0
		if ri < len(heights) {
			rh = heights[ri]
		}

		// Fill from bottom up
		for row := 0; row < lh && row < 4; row++ {
			pattern |= brailleDots[row][0]
		}
		for row := 0; row < rh && row < 4; row++ {
			pattern |= brailleDots[row][1]
		}
		result[i] = pattern
	}

	return string(result)
}

// AreaChart renders a multi-row braille area chart.
// Height is in character rows (each row = 4 dots tall).
// Width is in characters (each char = 2 dots wide).
func AreaChart(data []int, width, height int) []string {
	if len(data) == 0 || width == 0 || height == 0 {
		return nil
	}

	peak := 0
	for _, v := range data {
		if v > peak {
			peak = v
		}
	}
	if peak == 0 {
		lines := make([]string, height)
		empty := make([]rune, width)
		for i := range empty {
			empty[i] = '\u2800'
		}
		for i := range lines {
			lines[i] = string(empty)
		}
		return lines
	}

	// Resample to fit width
	cols := width * 2
	resampled := resample(data, cols)

	// Normalize to 0–(height*4), the total vertical dot resolution
	maxDots := height * 4
	dotHeights := make([]int, cols)
	for i, v := range resampled {
		if v > 0 {
			h := (v * (maxDots - 1) / peak) + 1
			if h > maxDots {
				h = maxDots
			}
			dotHeights[i] = h
		}
	}

	// Render rows top-down. Row 0 is topmost.
	lines := make([]string, height)
	for row := 0; row < height; row++ {
		chars := make([]rune, width)
		// This row covers dot positions [(height-1-row)*4, (height-row)*4)
		rowBase := (height - 1 - row) * 4

		for ci := 0; ci < width; ci++ {
			var pattern rune = 0x2800
			li := ci * 2
			ri := ci*2 + 1

			for dot := 0; dot < 4; dot++ {
				dotPos := rowBase + dot // absolute dot position from bottom
				if li < len(dotHeights) && dotHeights[li] > dotPos {
					pattern |= brailleDots[dot][0]
				}
				if ri < len(dotHeights) && dotHeights[ri] > dotPos {
					pattern |= brailleDots[dot][1]
				}
			}
			chars[ci] = pattern
		}
		lines[row] = string(chars)
	}

	return lines
}

// RollingAvg computes a rolling average with the given window size.
func RollingAvg(data []int, window int) []int {
	if len(data) == 0 || window <= 0 {
		return data
	}
	result := make([]int, len(data))
	sum := 0
	for i, v := range data {
		sum += v
		if i >= window {
			sum -= data[i-window]
		}
		w := window
		if i+1 < w {
			w = i + 1
		}
		result[i] = sum / w
	}
	return result
}

// resample maps data to a target number of columns using averaging.
func resample(data []int, cols int) []int {
	if len(data) == 0 || cols == 0 {
		return nil
	}
	result := make([]int, cols)
	for i := 0; i < cols; i++ {
		// Map column i to a range in data
		start := i * len(data) / cols
		end := (i + 1) * len(data) / cols
		if end <= start {
			end = start + 1
		}
		if end > len(data) {
			end = len(data)
		}
		sum := 0
		for j := start; j < end; j++ {
			sum += data[j]
		}
		result[i] = sum / (end - start)
	}
	return result
}
