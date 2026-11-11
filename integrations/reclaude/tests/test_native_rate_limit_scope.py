"""Quota scope must be backed by the native window, not the HTTP status."""
import unittest
from native_bridge_session import NativeRateLimit

class ScopeTests(unittest.TestCase):
    def info(self, window, total=.95):
        return {"status":"rejected", "rateLimitType":window,"resetsAt":1900000000,
                "unifiedWindows":{"seven_day":{"utilization":total,"resetsAt":1900000000}}}
    def test_fable_credits_leave_other_models_usable(self):
        d=NativeRateLimit("claude-fable-5-2",self.info("seven_day_overage_included"),"model_requires_usage_credits").details
        self.assertEqual(d["quota_scope"],"model")
        self.assertEqual(d["quota_family"],"fable")
        self.assertNotIn("weekly_utilization",d)
    def test_account_only_for_confirmed_weekly_exhaustion(self):
        d=NativeRateLimit("claude-opus-5-5",self.info("seven_day",1.01),"usage_limit_reached").details
        self.assertEqual(d["quota_scope"],"account")
        for window,level,error in [("five_hour",1.01,"usage_limit_reached"),("seven_day",.99,"usage_limit_reached"),("seven_day",True,"usage_limit_reached"),("seven_day",float("nan"),"usage_limit_reached"),("seven_day",1.01,"model_requires_usage_credits")]:
            with self.subTest(window=window,level=level,error=error):
                d=NativeRateLimit("claude-opus-5-5",self.info(window,level),error).details
                self.assertNotEqual(d.get("quota_scope"),"account")
        bad=self.info("seven_day",1.01);bad["unifiedWindows"]["seven_day"]["resetsAt"]+=1
        self.assertNotEqual(NativeRateLimit("claude-opus-5-5",bad,"usage_limit_reached").details.get("quota_scope"),"account")
