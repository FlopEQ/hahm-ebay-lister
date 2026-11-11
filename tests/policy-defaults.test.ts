import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPolicyId, withPolicyDefaults } from "@/lib/ebay/policy-defaults";
import { fetchAccountSetup, fetchAccountPolicyOptions } from "@/lib/ebay/publish";
afterEach(() => vi.unstubAllGlobals());
const policies = [ { id: "wrong", name: "Paid Shipping" }, { id: "media", name: "Free - Media Mail" } ];
describe("automatic business policy defaults", () => {
  it("uses the same named defaults for displayed options and server publication setup", async () => {
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const url = String(raw);
      let body;
      if (url.includes("fulfillment_policy")) body = {fulfillmentPolicies:[
        {fulfillmentPolicyId:"paid",name:"Paid Shipping"},{fulfillmentPolicyId:"media",name:"Free - Media Mail"}]};
      else if (url.includes("payment_policy")) body = {paymentPolicies:[
        {paymentPolicyId:"old",name:"Old payment"},{paymentPolicyId:"pay",name:"Managed Payments"}]};
      else if (url.includes("return_policy")) body = {returnPolicies:[
        {returnPolicyId:"other",name:"Other returns"},{returnPolicyId:"ret",name:"Default Return Policy"}]};
      else if (url.includes("/location")) body = {locations:[{merchantLocationStatus:"ENABLED",merchantLocationKey:"origin"}]};
      else throw new Error("Unexpected request " + url);
      return Response.json(body);
    }));
    const options = await fetchAccountPolicyOptions("policy-default-test");
    expect(options.defaults).toEqual({fulfillmentPolicyId:"media",paymentPolicyId:"pay",returnPolicyId:"ret"});
    expect(await fetchAccountSetup("policy-default-test")).toEqual({...options.defaults,locationKey:"origin"});
  });
  it("selects the named shipping policy regardless of account order", () => {
    expect(defaultPolicyId(policies, "Free - Media Mail")).toBe("media");
    expect(defaultPolicyId([...policies].reverse(), "Free - Media Mail")).toBe("media");
  });
  it("supports exact server overrides and never substitutes a missing configured policy", () => {
    expect(defaultPolicyId(policies, "Free - Media Mail", "wrong")).toBe("wrong");
    expect(defaultPolicyId(policies, "Free - Media Mail", undefined, "Paid Shipping")).toBe("wrong");
    expect(defaultPolicyId(policies, "Free - Media Mail", "deleted")).toBe("");
    expect(defaultPolicyId(policies.slice(0,1), "Free - Media Mail", undefined, "Deleted Policy")).toBe("");
  });
  it("accepts a unique standard-name suffix but refuses ambiguity and unrelated choices", () => {
    expect(defaultPolicyId([{id:"pay",name:"Managed Payments (Default)"}], "Managed Payments")).toBe("pay");
    expect(defaultPolicyId([{id:"a",name:"Managed Payments A"},{id:"b",name:"Managed Payments B"}], "Managed Payments")).toBe("");
    expect(defaultPolicyId(policies, "Not present")).toBe("");
    expect(defaultPolicyId([{id:"only",name:"Only policy"}], "Not present")).toBe("only");
  });
  it("captures defaults without replacing manual choices, condition, or item data", () => {
    const listing = {title:"Book",description:"Seller description",ebay_condition:"USED_GOOD",fulfillment_policy_id:"manual"};
    const defaults = {fulfillmentPolicyId:"media",paymentPolicyId:"pay",returnPolicyId:"ret"};
    const result = withPolicyDefaults(listing, {fulfillmentPolicies:[],paymentPolicies:[],returnPolicies:[],defaults});
    expect(result).toEqual({...listing,payment_policy_id:"pay",return_policy_id:"ret"});
    expect(listing).not.toHaveProperty("payment_policy_id");
  });
});
