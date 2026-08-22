export function head(items, n) {
	if (!Number.isInteger(n) || n < 0 || n > items.length) throw new RangeError(`n 越界: ${n}`);
	return items.slice(0, n);
}

export function tail(items, n) {
	if (!Number.isInteger(n) || n < 0 || n > items.length) throw new RangeError(`n 越界: ${n}`);
	return items.slice(items.length - n);
}

export function drop(items, n) {
	if (!Number.isInteger(n) || n < 0 || n > items.length) throw new RangeError(`n 越界: ${n}`);
	return items.slice(n);
}
