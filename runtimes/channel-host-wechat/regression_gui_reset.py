"""Regression: GUI send exception must drop the cached GUI instance.

Scenario (2026-09-05 incident): WeChat restarted between two sends; the
cached WeChatGUI kept a dead window handle, so every later send failed with
COM `事件无法调用任何订户` until a manual channel-host restart.
"""

from channel_host.outbound import WeChatChannelSender


class FlakyGui:
    def __init__(self, generation: int):
        self.generation = generation

    def send_msg(self, text, target_name, verify=True):
        if self.generation == 1:
            raise OSError(
                "(-2147220991, '事件无法调用任何订户', (None, None, None, 0, None))"
            )
        return {"status": "成功", "message": "ok"}


def main() -> None:
    generations: list[int] = []

    def gui_factory() -> FlakyGui:
        gui = FlakyGui(len(generations) + 1)
        generations.append(gui.generation)
        return gui

    sender = WeChatChannelSender(
        db=type("DB", (), {"get_nickname": staticmethod(lambda ref: "Leaif")})(),
        gui_factory=gui_factory,
    )

    first = sender.send_text("conv-ref", "hello")
    assert first.state == "unknown", f"first send should be unknown, got {first.state}"
    assert "事件无法调用任何订户" in (first.error or ""), first.error
    assert len(generations) == 1, generations
    assert sender._gui is None, "GUI instance must be dropped after exception"

    second = sender.send_text("conv-ref", "hello again")
    assert second.state == "confirmed", f"second send should confirm, got {second.state}"
    assert len(generations) == 2, "a fresh GUI must be built for the retry"
    assert sender._gui is not None and sender._gui.generation == 2

    print("REGRESSION OK: send exception drops GUI; next send rebuilds it")


if __name__ == "__main__":
    main()
