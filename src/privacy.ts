export interface PrivacyParams {
  epsilon: number;
  delta?: number;
  sensitivity: number;
}

export interface NoisyResult {
  value: number;
  mechanism: "laplace" | "gaussian";
  epsilon_used: number;
  noise_scale: number;
}

export function laplaceMechanism(trueValue: number, params: PrivacyParams) {
  const { epsilon, sensitivity } = params;
  if (epsilon <= 0) throw new Error("Epsilon must be positive");
  if (sensitivity <= 0) throw new Error("Sensitivity must be positive");

  const scale = sensitivity / epsilon;
  const noise = sampleLaplace(0, scale);

  return {
    value: trueValue + noise,
    mechanism: "laplace",
    epsilon_used: epsilon,
    noise_scale: scale,
  };
}

export function gaussianMechanism(
  trueValue: number,
  params: PrivacyParams,
): NoisyResult {
  const { epsilon, delta, sensitivity } = params;
  if (!delta || delta <= 0 || delta >= 1)
    throw new Error("Delta must be in (0,1) for Gaussian");
  if (epsilon <= 0) throw new Error("Epsilon must be positive");

  const sigma = (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / epsilon;
  const noise = sampleGaussian(0, sigma);

  return {
    value: trueValue + noise,
    mechanism: "gaussian",
    epsilon_used: epsilon,
    noise_scale: sigma,
  };
}

// --- all the utility function will be written here
function sampleLaplace(mu: number, b: number): number {
  const u = Math.random() - 0.5;
  return mu - b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

function sampleGaussian(mu: number, sigma: number): number {
  const u1 = Math.random();
  const u2 = Math.random();

  const z = Math.sqrt(-2 * Math.log(u1) * Math.cos(2 * Math.PI * u2));

  return mu + sigma * z;
}

/**
 * here we are just calculating the privacy cost of k repeated queries
 * like the basic composition here will be using RDP or zCDP for tightinening the bounds
 */

export function basicComposition(epsilon: number[]): number {
  return epsilon.reduce((sum, e) => sum + e, 0);
}

export function rdpToDP(
  rdpEpsilon: number,
  alpha: number,
  delta: number,
): number {
  return rdpEpsilon + Math.log(1 / delta) / (alpha - 1);
}
