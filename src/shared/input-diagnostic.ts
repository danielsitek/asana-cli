export const describeInput = (input: string): string => {
  const displayed = input.replace(/\p{C}/gu, " ");
  const truncated =
    displayed.length > 80 ? `${displayed.slice(0, 79)}…` : displayed;
  return JSON.stringify(truncated);
};
