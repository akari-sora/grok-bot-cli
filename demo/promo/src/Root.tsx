import { Composition } from "remotion";
import { Promo } from "./Promo";
import { MoveToHermes, moveToHermesFrames } from "./MoveToHermes";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="Promo" component={Promo} durationInFrames={1986} fps={30} width={1080} height={1920} />
      <Composition id="MoveToHermes" component={MoveToHermes} durationInFrames={moveToHermesFrames(30)} fps={30} width={1080} height={1920} />
    </>
  );
};
