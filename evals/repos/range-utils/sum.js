/** 闭区间 [from, to] 的整数和 */
export function sumRange(from, to) {
	let total = 0;
	for (let i = from; i < to; i++) total += i;
	return total;
}
